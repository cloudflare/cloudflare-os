// The Durable Object storage of a Google Doc: its copy, what each pending edit made and each
// rendering, as rows of the object's SQLite. A tab is a version: an ordered list of immutable runs
// of pruned JSON (`./docs-runs`), each named by its content within its document and rendered
// alone, and the tab's small data. An edit makes a child version that shares every run whose
// content is the same, and what code derived of a tab is stored under a digest of that code.
// Every row is one document's: nothing stored for a document is read or written for another.
// Two rules hold for every caller: a version's handle is valid only until the next await, and
// nothing outside storage remembers a version.
import { createHash } from "node:crypto";
import type {
  GoogleDocsDocument, GoogleDocsRequest, GoogleDocsTab, StructuralElement,
} from "./docs-api";
import { DOC_DERIVED } from "./docs-derived";
import {
  hasModelFootnotes, hasModelIndexes, isModelIndexed, markModelIndexed, MODEL_LIST_ID,
  modelFollowing, type BatchReach, type SliceEdgeError, type SliceResult, type TabSlice,
} from "./docs-model";
import type { DocRefusal } from "./docs-replay";
import {
  DOC_COPY_FORMAT_VERSION, DOC_COPY_UNREADABLE, fetchedDoc, tabIdentity, type DocWriteMarkerCopy,
  type FetchedDoc, type FetchedDocTab, type GoogleDocTabIdentity,
} from "./docs-replica";
import { cutRuns, decodeRun, RUN_SIZES, type CutRun, type RunSizes } from "./docs-runs";
import { tableCellCount, tableShape } from "./docs-tables";
import {
  advanceCarry, CarryBeside, closureOf, closureStart, ELEMENT_TABLE, initialCarry, isBlankDocTab,
  joinRenderedRun, namedListIds, noRenderedRuns, pieceRendering, renderRun, runCarryKey,
  runContextKey, type DocTabPart, type DocTabSnapshot, type OwnElements,
  type OwnRange, type PassCarry, type RenderCarry, type RenderContext, type RenderedRun,
  type RunElements, type RunSummary,
} from "./markdown-converter";

/**
 * The name of a run, and of every other row the store names by its content: the SHA-256 of the
 * UTF-8 of `json`, as 64 lowercase hex digits. `json` is the string that is stored, made by
 * `JSON.stringify`, whose output holds no lone surrogate, so two different strings never share
 * their UTF-8. Synchronous, so that a row is named where it is written, inside `transactionSync`
 * and inside a fold's reducer alike. A row is named here, and a version, as its runs' names
 * pass, by `versionNamer`, to the same bytes: the two places a row is named.
 */
export function runId(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The most bytes the TEXT of one row may hold, counted as UTF-8: under the 8 MiB a Durable
 * Object's SQLite takes in one row, whichever way "8 MB" is read.
 */
export const DOC_ROW_BYTES = 8_000_000;

/**
 * Thrown where one item of a document is too large for one stored row. `what` says which item,
 * in words a reader of the Doc is given; `bytes` is its size as stored.
 */
export class DocRowTooLargeError extends Error {
  readonly bytes: number;

  constructor(what: string, bytes: number) {
    super(
      `${what} is too large to keep a copy of: ${bytes} bytes as stored, and one stored row ` +
      `holds ${DOC_ROW_BYTES}. It cannot be read or edited through this connection until it is ` +
      "made smaller in Google Docs.",
    );
    this.name = "DocRowTooLargeError";
    this.bytes = bytes;
  }
}

/**
 * The format the tables and what Google sent were written under: the copy's format
 * (`DOC_COPY_FORMAT_VERSION`), which names what the pruning keeps and the rows a tab is stored
 * as. A store opened under another format makes its tables again, empty, so no tab is read
 * under a pruning, and no row is written to a table, other than this code's. What code derived
 * of a tab is versioned apart, by `DOC_DERIVED`.
 */
export const DOC_STORE_FORMAT: string = `${DOC_COPY_FORMAT_VERSION}`;

/**
 * The grain, in milliseconds, of the time a copy's record keeps of its last approval by a scope
 * check (`DocCopyHead.approvedAt`): the clock is rounded down to it, so that the reads of one
 * copy approved within one grain write its record once.
 */
export const DOC_COPY_APPROVAL_GRAIN_MS = 3_600_000;

/** How many bytes `text` is as UTF-8, without encoding it. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    let unit = text.charCodeAt(at);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair is one character of four bytes.
      bytes += 4;
      at++;
    } else bytes += 3;
  }
  return bytes;
}

// An item past one row is refused, not split: supporting it would mean storing the item in parts.
// The measure is the UTF-8 of the row's TEXT values together, which is what storage counts: the
// length of a string says too little (text outside Latin-1 is three bytes a character), so a row
// whose characters cannot pass the limit at three bytes each is let through unread, and any other
// is counted in one pass that allocates nothing.
function requireRow(what: string, ...texts: readonly string[]): void {
  let length = 0;
  for (let text of texts) length += text.length;
  if (length * 3 <= DOC_ROW_BYTES) return;
  let bytes = 0;
  for (let text of texts) bytes += utf8Bytes(text);
  if (bytes > DOC_ROW_BYTES) throw new DocRowTooLargeError(what, bytes);
}

/**
 * A run, or a run's Markdown, as `DocRowTooLargeError` names it: by what the run holds first. A
 * run past a row is one element, since a run of several is cut far below a row.
 */
function runNamed(tabId: string, holds: CutRun["holds"]): string {
  let held = holds === "table" ? "A table" : holds === "paragraph" ? "A paragraph" : "An element";
  return `${held} of tab "${tabId}" of this Google Doc`;
}

/** What `elements`, a run decoded, holds first: `CutRun.holds` of the run. */
function heldBy([opening]: readonly StructuralElement[]): CutRun["holds"] {
  return opening?.table ? "table" : opening?.paragraph ? "paragraph" : "element";
}

/** A tab's context, its lists and named styles, as `DocRowTooLargeError` names it. */
function listsNamed(tabId: string): string {
  return `The lists of tab "${tabId}" of this Google Doc`;
}

/**
 * What the renderer threw on a run the store was given to store, of a tab in hand (`putTab`)
 * or of a fetched document (`keep`, `trial`): a fault of the tab, not of storage. `cause` is what
 * was thrown; the message is fixed and holds nothing of the document.
 */
export class DocRunRenderError extends Error {
  constructor(cause: unknown) {
    super("A run of the tab could not be rendered.", { cause });
    this.name = "DocRunRenderError";
  }
}

/**
 * Thrown where a piece cannot be what was asked: its place names nothing of the version's
 * runs, or its closure is not where it was found to start. A fault of this code and never
 * of storage, and a function of the version and the own range: the same call throws it
 * again, so whoever builds an edit from a piece refuses the edit for it and nothing
 * retries. Its message is fixed and quotes nothing.
 */
export class DocPieceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocPieceError";
  }
}

/** The message of a `DocPieceError` for a piece asked of elements its version does not hold. */
export const PIECE_NAMES_NOTHING = "A piece was asked for elements its version's runs do not hold.";
// The message of a `DocPieceError` for a closure found to start before its first run.
const PIECE_STARTS_BEFORE = "A piece's closure starts before the run it was found to start in.";

/** Throws where `value` is a promise: a transaction commits only what ran before the first await. */
function requireSynchronous(value: unknown): void {
  if (typeof (value as { then?: unknown } | null | undefined)?.then === "function") {
    throw new Error("A DocStore transaction must be synchronous: its callback returned a promise.");
  }
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

/**
 * What the Doc store has spent in this isolate since it started, counted always (each is one
 * integer added or compared). Tests read the differences, and set a peak to 0 before the stretch
 * they measure; nothing else reads them.
 */
export type DocStoreCost = {
  /**
   * Runs parsed from their stored JSON: a row's, or a run of a held document read back to be
   * stored; a run of a slice, once for each attempt; a run of a piece, once for each attempt
   * and each scout.
   */
  runsDecoded: number;
  /**
   * Runs rendered to Markdown, wherever the code that renders stands. A run rendered alone,
   * for the Markdown and the summary that are then stored, is one: a run of a tab that is
   * kept, a run an edit changed, a later run whose key has no rendering, a run whose stored
   * rendering is missing, each run of a version keyed again under another digest. Each run
   * of A PIECE (`DocStore.piece`: what the checks and the builders of an edit read) is
   * rendered too, one at a time, once for each attempt and each scout, and stores none: an
   * approval's batch built from the copy is that. A tab in a caller's hand rendered whole
   * (`tabRendered`) adds the runs the store decoded the tab from or cut it into, and 1 for a
   * tab the store did neither with, which is in one piece.
   */
  runsRendered: number;
  /**
   * Runs whose rendering's key was worked out from a stored summary, with no element read:
   * the runs after the ones an edit or a fetch changed, up to where the carry is the earlier
   * version's again; to the end of the tab where it never is (a list renumbered to its
   * end, a footnote added) or where a run the earlier version lists more than once leaves
   * the walk out of step.
   */
  runsKeyed: number;
  /**
   * Times an edit's batch was applied again to more runs because the model read an element
   * the runs in hand did not hold (`DocStore.widen`). Each one decodes its runs again.
   */
  viewWidenings: number;
  /**
   * Times a piece of a tab took more runs because its closure was not whole in the runs in
   * hand (`DocStore.piece`): a run added after, an attempt made again from an earlier run,
   * or a scout of the runs before, each of which decodes and renders its runs again.
   */
  pieceWidenings: number;
  /**
   * The most bytes of run JSON the store held as strings at one moment, a string counted at two
   * bytes a character: one run, read to be parsed or made to be stored, so the longest run of
   * the version read or of the version an edit gives. A read has one run's elements in hand
   * at a time beside it. An edit holds more, as objects that are not in it: while its
   * builders run, the elements of the runs of its own elements and of the run before them,
   * which its piece keeps decoded (`DocStore.piece`), and then the runs its batch touches
   * and the runs cut from them.
   */
  peakRunBytesInHand: number;
  /**
   * The longest Markdown, in characters, that was in hand in one call: a version's, answered
   * (`markdown`); a piece's joined runs, each attempt's, and one run's of a scout (`piece`,
   * what the builders of an edit read); a tab's in a caller's hand, rendered whole
   * (`tabRendered`); one run's, rendered to be stored or read by a walk or a reader (`walk`,
   * `reader`); or what a caller holds of the runs it read, as it says it (`markdownHeld`: a
   * scan of a walk's runs, a card's two strings together). A caller that makes an edit holds
   * the Markdown of the piece around it while the builders run, and one run's of the tab
   * after at a time; a card compares the runs in which the tab reads otherwise, a run of
   * each version in hand, and then holds its two strings. The peak counts each alone, so
   * what is in hand at any moment is at most twice it.
   */
  peakMarkdownCharsInHand: number;
  /** The characters the comparisons of a card's span were handed, over every comparison. */
  spanCharsCompared: number;
  /** Rows written, as storage counts them for each statement the store ran. */
  rowsWritten: number;
  /** Results of an edit in a version that were made and stored. */
  resultsStored: number;
  /** Results of an edit in a version that were found stored. */
  resultsFound: number;
  /**
   * The most bytes of run JSON that one pass over a fetched document had been handed by the
   * cut and had neither written nor let go, at one moment: a run as a string is counted at
   * two bytes a character, a run packed in a held document (`heldDoc`) at its UTF-8. A
   * document stored as it is read adds a run when the cut hands it over (or it is read back)
   * and takes it off once its rows are written, so its peak is one run. Holding a document
   * keeps every run, as bytes, so that pass's peak is the bytes of all its runs and one run
   * as a string.
   *
   * IT COUNTS WHAT THE PASS IS HANDED, NOT WHAT IS REACHABLE. Not in it: the JSON of the
   * elements of the run the cut is still building and of the element read past it (the cut's
   * own, at most one run and one element more); the elements and the parsed answer, which
   * are objects; and the pack a held document is read back from, which is the document being
   * read. So it shows a pass that gathers runs before it writes them, and it does not show a
   * pass that keeps what it has written: that the answer's elements and the runs written can
   * be collected is held by the tests that watch them (weak references and the heap), not by
   * this number.
   */
  ingestPeakBufferedBytes: number;
};

/** The running totals of `DocStoreCost`. */
export const docStoreCost: DocStoreCost = {
  runsDecoded: 0, runsRendered: 0, runsKeyed: 0, viewWidenings: 0, pieceWidenings: 0,
  peakRunBytesInHand: 0, peakMarkdownCharsInHand: 0, spanCharsCompared: 0, rowsWritten: 0,
  resultsStored: 0, resultsFound: 0, ingestPeakBufferedBytes: 0,
};

function runInHand(json: string): void {
  docStoreCost.peakRunBytesInHand = Math.max(docStoreCost.peakRunBytesInHand, 2 * json.length);
}

/** Counts `chars` of Markdown in hand at one moment (`peakMarkdownCharsInHand`). */
export function markdownHeld(chars: number): void {
  docStoreCost.peakMarkdownCharsInHand = Math.max(docStoreCost.peakMarkdownCharsInHand, chars);
}

function markdownInHand(markdown: string): void {
  markdownHeld(markdown.length);
}

// What one pass over a fetched document has in hand of its runs' JSON, in bytes: made by the
// pass and gone with it, so a pass that throws leaves nothing to put back.
type InHand = { bytes: number };

// Moves `inHand` by `bytes` (negative for what is let go) and notes the most it has been.
function inHandBy(inHand: InHand, bytes: number): void {
  inHand.bytes += bytes;
  docStoreCost.ingestPeakBufferedBytes =
    Math.max(docStoreCost.ingestPeakBufferedBytes, inHand.bytes);
}

// How many runs a tab still in a caller's hand is: the runs `DocStore.tab` decoded it from, or
// the runs `DocStore.putTab` cut it into. Weak, so it holds no tab. Read by `tabRendered`
// alone, for a tab rendered whole in hand, which nothing that reads or edits a document does.
const runsOfTab = new WeakMap<GoogleDocsTab, number>();

/**
 * Counts `rendering`, a rendering of `tab` whole, in hand (`docTabToMarkdown`): each of the
 * tab's runs rendered (`runsRendered` moves by the runs the store decoded `tab` from, `tab`,
 * or cut it into, `putTab`; by 1 for a tab it did neither with) and the Markdown in hand
 * (`peakMarkdownCharsInHand`). Whoever renders a tab whole calls it: `renderTab` alone, the
 * edit on a tab in hand that the store's path is held to; nothing that reads or edits a
 * document renders a tab whole.
 */
export function tabRendered(tab: GoogleDocsTab, rendering: Pick<DocTabSnapshot, "markdown">): void {
  docStoreCost.runsRendered += runsOfTab.get(tab) ?? 1;
  markdownInHand(rendering.markdown);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the Doc store needs of a Durable Object's storage: `ctx.storage` is one. */
export type DocStoreStorage = {
  readonly sql: {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): {
      toArray(): T[];
      one(): T;
      readonly rowsWritten: number;
    };
  };
  /** Runs `callback` atomically; a throw undoes its SQL and KV writes. Nests. */
  transactionSync<T>(callback: () => T): T;
};

/**
 * One state of a tab, by handle: what a read asks of it without reading a run or a rendering.
 * What an edit or its card asks of the RENDERING without its Markdown (its length, whether it
 * is blank, its tables) is asked a page of the runs' small rows at a time (`DocStore.walk`,
 * `DocStore.reader`, or a `storedTabReading`), never of `DocStore.summary`, which lists every
 * table of the tab. VALID ONLY UNTIL
 * THE NEXT AWAIT: a later request may remove the version (an approval, a rejection, a fetch), so
 * a caller reads what it wants through the handle in the synchronous stretch it got it in, and
 * keeps the handle nowhere. A version never changes: the same id is the same content, so a
 * handle kept too long reads what it named or fails with `DOC_COPY_UNREADABLE`, never another
 * tab's text.
 */
export type DocVersion = GoogleDocTabIdentity & {
  /**
   * The version's name: `runId` of its document key, its tab's id, `bodyEndIndex`, `exact`,
   * its context and its runs. WHAT THE TAB IS CALLED, WHERE IT STANDS IN THE OUTLINE AND ITS
   * WRITE MARKERS ARE NOT IN IT: no stored result and no rendering reads them, so a tab
   * renamed, moved or fetched again with another marker is the same version and keeps what
   * was stored for it.
   */
  readonly id: string;
  /** The document the version belongs to, as `DocStore.keep` was given it. */
  readonly doc: string;
  /**
   * Where the body ends: the tab's first index plus the sizes of its runs, which is the end
   * index of the body's last element where that element holds one, and 0 for an empty body.
   */
  readonly bodyEndIndex: number;
  /**
   * Whether the model made the tab (`isModelIndexed`): every index exact and no empty text run,
   * which a decode says of the tab again (`markModelIndexed`), so that an edit made in it starts
   * with nothing to recompute. A tab as Google sent it is not.
   */
  readonly exact: boolean;
  /**
   * The write markers the tab held when it was fetched (`DocWriteMarkerCopy`), in Google's
   * order. A version an edit made holds those of the version it was made in.
   */
  readonly writeMarkers: readonly DocWriteMarkerCopy[];
};

/** What the table checks read of one table, kept with the Markdown of the run that holds it. */
export type DocTableSummary = {
  /** Where the table starts, as a document index counted from the run's first index. */
  readonly start: number;
  /** `runId` of `tableShape` of the table's HTML: the same for two tables that read the same. */
  readonly shape: string;
  /** `tableCellCount` of the table's HTML. */
  readonly cells: number;
  /** Whether the table's HTML holds an ordered list. */
  readonly numbered: boolean;
  /**
   * The table's range in the Markdown, `[mdStart, mdEnd)`, counted from the start of the run's
   * Markdown: what tells whether lines shown on a card are all of one table.
   */
  readonly mdStart: number;
  readonly mdEnd: number;
};

/**
 * What readers ask of a rendering without its Markdown or its source map. Stored with each
 * run's Markdown; `DocStore.summary` answers the one of a whole version, its runs' joined (the
 * lengths and counts added, each table's `start`, `mdStart` and `mdEnd` moved by the runs
 * before it).
 */
export type DocRunSummary = {
  /** The Markdown's length in characters. */
  readonly markdownLength: number;
  /** Whether the rendering is of nothing: `isBlankDocTab`. */
  readonly blank: boolean;
  /** How many blocks the source map holds. */
  readonly blocks: number;
  /** How many protected ranges the source map holds. */
  readonly protectedRanges: number;
  /** Whether a block is an item of a numbered list. */
  readonly numberedItems: boolean;
  /** The run's tables, in order. */
  readonly tables: readonly DocTableSummary[];
};

/** The places of some consecutive runs in a version's list of runs: `[from, to)`. */
export type RunPlaces = { readonly from: number; readonly to: number };

/**
 * One stored run of a version, as `DocStore.walk` hands it, valid during that call of `each`,
 * and as a `DocStore.reader` hands it, valid until the reader is asked again.
 */
export type StoredRun = {
  /** Its place in the version's list of runs. */
  readonly place: number;
  /** Its length in document indexes. */
  readonly size: number;
  /** The summary of its rendering: every offset counted from the run's own start. */
  readonly summary: DocRunSummary;
  /** Its stored Markdown, read when asked: one row. */
  markdown(): string;
  /**
   * Names the run's stored rendering: two runs of one tab with the same `entry` are one
   * row, so they read alike with nothing read. Opaque: compared, never taken apart.
   */
  readonly entry: string;
  /**
   * Names the run's content: two runs of one document with the same `content` hold the same
   * elements, wherever each stands. Opaque, as `entry` is.
   */
  readonly content: string;
  /**
   * Its elements, decoded when asked: one row. Their indexes are counted from `first`, the
   * index the run starts at, and their footnote numbers from `footnotes`, how many footnote
   * references the runs before it hold (`decodeRun`): the run knows neither, and who passed
   * the runs before it does. It reads by the run's name alone, so, unlike the rest, it may
   * be asked for as long as the version's handle is valid. Counts a run decoded.
   * @throws As `tab` does where the run cannot be read back.
   */
  elements(first: number, footnotes?: number): StructuralElement[];
};

/**
 * Some consecutive runs of a version decoded, for ONE SYNCHRONOUS STRETCH: what the model is
 * handed of a tab. Never kept past the stretch, and never read again once the model threw on
 * it: `piece` is the model's draft. `from` and `to` are the places, in the version's list of
 * runs, of the runs it holds.
 */
export type DocSlice = RunPlaces & {
  readonly version: DocVersion;
  /** The runs' elements at their place in the tab, and the tab's shared data. */
  readonly piece: TabSlice;
  /**
   * The two carries `putSlice` needs, with no copy of either: `carries.ours` is what the
   * renderer carries into the slice's first run from the runs before it (the walk's own
   * carry, handed on where the walk ends: `putSlice` renders the runs that take the slice's
   * place with it and moves it past them), and beside it, held as what differs, the
   * version's carry AFTER the slice's last run as it is stored, which `putSlice` asks where
   * the keys of the later runs stop moving. The slice owns it until `putSlice`; a slice that
   * is not stored lets it go.
   */
  readonly carries: CarryBeside;
};

/**
 * Where the run that holds the first of an edit's own elements stands in its version. For
 * a table, the run that holds it; for `"end"`, the version's last run; for a Markdown
 * range, THE RUN THAT HOLDS THE OFFSET `mdStart`: the last run whose Markdown starts at or
 * before the offset AND THAT WRITES A CHARACTER. A run that writes nothing (the body's
 * opening section break kept alone, elements the pruning left with nothing to render)
 * starts where the next run does and holds no offset; where no run that writes stands at
 * or before the offset there is none after it either (the tab's Markdown is empty), and
 * the run is the version's last.
 */
export type PieceAt = {
  /** The run's place in the version's list. */
  readonly place: number;
  /** Where the run's Markdown starts in the tab's. */
  readonly mdStart: number;
  /** How many of the tab's tables stand before the run. */
  readonly tablesBefore: number;
  /** The own elements, in the tab's units. */
  readonly own: OwnRange;
};

/**
 * The closure of an edit's own elements, rendered from stored runs, for ONE SYNCHRONOUS
 * STRETCH: what the builders of an edit read of its tab. Never kept past the stretch.
 */
export type DocPiece = RunPlaces & {
  readonly version: DocVersion;
  /**
   * The local rendering (`pieceRendering`), with the version's identity and
   * `bodyEndIndex`; `part` is not set here: who holds the reading sets it.
   */
  readonly rendering: DocTabSnapshot;
  /** Where the piece stands in the tab: `DocTabPart` without what its holder adds of the tab. */
  readonly at: Omit<DocTabPart, "tab">;
  /**
   * The run before `at.place`, where the piece holds it, and the runs of the own elements,
   * as they were decoded for the rendering, by place, each with every index it has in the
   * tab: its keys are exactly the places from `max(a, p - 1)` to `l` (`a` the piece's first
   * run, `p` `at.place`, `l` the run of the own range's last element), and never a run
   * after `l`. No other run of the piece is kept decoded. Whoever hands one to the model
   * takes it out of the map: the model may change it, and with it the text styles
   * `rendering.sourceMap` shows.
   */
  readonly decoded: Map<number, { elements: StructuralElement[]; footnotes: number }>;
};

/** What an edit made in a version, as stored: its requests and the version they give, or why not. */
export type StoredDocEditResult =
  | { readonly requests: readonly GoogleDocsRequest[]; readonly after: DocVersion }
  | { readonly refusal: DocRefusal };

/**
 * What a sweep keeps of a document beyond the base versions of its stored copy: what the
 * pending records still reach. Computed from the records each time (`pendingDocKeys`), never
 * remembered.
 */
export type DocPending = {
  /** The key (`docEditKey`) of each pending edit a replay folds. */
  readonly edits: readonly string[];
  /**
   * The id (`DocStore.versionId`) of each version a pending record makes with no version
   * before it: the blank tab of a pending add, which the edits queued in that tab start from.
   */
  readonly roots: readonly string[];
};

/** The record that names a document's stored copy. */
export type DocCopyHead = {
  /**
   * The copy's name: `runId` of its revision, its tabs' versions, its outline and its tabs'
   * write markers. The same document state fetched twice has the same name.
   */
  readonly id: string;
  readonly revision?: string;
  /** The clock when the fetch that brought the copy began. A revision check does not move it. */
  readonly fetchedAt: number;
  /** The clock when the copy was last fetched or confirmed; absent, the copy is due a check. */
  readonly checkedAt?: number;
  /**
   * Set once a write reached the provider since the copy was fetched: served to no one, and
   * held by no view (`holds`). Each host sets it where its write lands.
   */
  readonly stale: boolean;
  /** Every tab's identity, in the document's order. */
  readonly outline: readonly GoogleDocTabIdentity[];
  /** The id of each tab's base version, in the outline's order. */
  readonly versions: readonly string[];
  /** The write markers each tab held when it was fetched, in the outline's order. */
  readonly writeMarkers: readonly (readonly DocWriteMarkerCopy[])[];
  /**
   * The Drive folder the session stood on whose approved read kept the copy, or was the last
   * to be approved over it. Absent for a copy no folder session kept: a bound Doc's, and one
   * read through a connection bound to a file or to the whole account.
   */
  readonly folder?: string;
  /**
   * The clock, rounded down to `DOC_COPY_APPROVAL_GRAIN_MS`, when a scope check last approved
   * a read of the copy: the read that kept it, or a later one that reused it. Absent for a
   * bound Doc's copy, which no scope check guards. It says how long a copy has gone with no
   * approved read.
   */
  readonly approvedAt?: number;
  /**
   * The digest (`DOC_DERIVED`) the document was last swept under. Where it is another than
   * the store's, the document may still hold derived rows made under another digest, which
   * are served to no one and which its next sweep removes.
   */
  readonly made: string;
  /**
   * What the copy holds of the document as Google sent it, in bytes: the UTF-8 length of the
   * stored JSON of every run its tabs list (a run counted at each place a tab lists it) and
   * of each tab's context (its lists and named styles). Counted as the document is stored,
   * from the runs in hand, so no stored content is read to know it. NOT COUNTED: the runs'
   * renderings, the lists of runs, and what the document's pending edits made (their
   * versions' runs, renderings and requests).
   */
  readonly bytes: number;
};

/** One stored copy's small record, as a pass over a store's copies reads it. */
export type DocCopyRecord = {
  /** The document's key in the store. */
  readonly doc: string;
  /** `DocCopyHead.approvedAt`; absent for a copy no scope check guards. */
  readonly approvedAt?: number;
  /** `DocCopyHead.fetchedAt`. */
  readonly fetchedAt: number;
  /** `DocCopyHead.bytes`. */
  readonly bytes: number;
};

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

// THE COLUMN RULE: in every table the small columns come first and the one large TEXT column is
// the last. SQLite reaches a column by walking the row, so a small column declared after a large
// one costs a walk of the large one's overflow pages each time it is read alone.
// The content tables (`doc_run`, `doc_md`, `doc_result`) are ordinary tables, whose large rows
// then stay out of the key's tree; the tables of small rows are WITHOUT ROWID. There is no
// secondary index.
const TABLES: readonly string[] = [
  // Immutable content of one document, named by the document and the hash of the content: a
  // run (a JSON array of consecutive pruned body elements in their stored form, `cutRuns`) or
  // a tab's context (JSON of its lists and named styles). Keyed by document first, so a
  // document's content is one range of the key, removed by that range. Two documents that
  // hold the same content hold a row each: no statement asks what another document lists.
  `CREATE TABLE IF NOT EXISTS doc_run (
    doc TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (doc, id)) STRICT`,
  // A run's rendering, by the document and what it was rendered from: the run, the context
  // the rendering read beside it, and the normal form of the state the renderer carried into
  // it. `made` is the digest of the code that rendered it: a row is read only under its own.
  // `summary` is JSON of `DocRunSummary` with the renderer's summary of the run beside it
  // (`run`, a `RunSummary`), and `md` the Markdown as `markdownAsStored` gives it. A row holds
  // ONE run's rendering, the run its key names, whichever version listed it first: two
  // versions OF ONE DOCUMENT that share a run under one key share the row.
  `CREATE TABLE IF NOT EXISTS doc_md (
    doc TEXT NOT NULL, run TEXT NOT NULL, context TEXT NOT NULL, carry TEXT NOT NULL,
    made TEXT NOT NULL, summary TEXT NOT NULL, md TEXT NOT NULL,
    PRIMARY KEY (doc, run, context, carry)) STRICT`,
  // A version's runs, in order, a row a run: each with the key of its rendering's row and its
  // length in document indexes (`CutRun.size`). `run`, `seq` and `size` are what Google sent, or
  // what the model made, as this code cut it; `context` and `carry` are keys the renderer's
  // rules derive, read only where the version's `derived` says they were written under the
  // store's digest: `context` is '' for a run that names no list and holds no subtitle and
  // otherwise `runId` of what the run reads of the tab's lists and named styles
  // (`runContextKey`), and `carry` is what the run shows of the state the renderer carries into
  // it (`runCarryKey`), as text, mostly ''. A version's first index is its `bodyEndIndex` less
  // the sum of its sizes, and a run's is that plus the sizes before it.
  `CREATE TABLE IF NOT EXISTS doc_seq (
    version TEXT NOT NULL, seq INTEGER NOT NULL,
    run TEXT NOT NULL, context TEXT NOT NULL, carry TEXT NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (version, seq)) STRICT, WITHOUT ROWID`,
  // One state of a tab: its document, its small data (JSON {"tabId", "bodyEndIndex", "exact"})
  // and the `doc_run` id of its context. Keyed by document first, so a document's versions are
  // one range of the table. `id`, `context` and `meta` never change. What a tab is called, where
  // it stands and its write markers are the copy's, not the version's. `derived` is what code
  // worked out of the tab beside what it holds, JSON {"made": digest, "unindexed"?: boolean,
  // "keyed"?: true}: read only under its own digest, and worked out again under another.
  // `unindexed` says the model cannot follow the tab; `keyed` that every row of the version's
  // run list holds this code's keys and had its rendering stored.
  `CREATE TABLE IF NOT EXISTS doc_version (
    doc TEXT NOT NULL, id TEXT NOT NULL, context TEXT NOT NULL, derived TEXT NOT NULL,
    meta TEXT NOT NULL,
    PRIMARY KEY (doc, id)) STRICT, WITHOUT ROWID`,
  // What an edit made in a version: `made` is the digest of the code that made it (a row is read
  // only under its own); `child` is the version it gives (the version itself for an edit that
  // changes nothing, NULL for a refusal); `result` is JSON, {"requests": [...]} or
  // {"refusal": {...}}. An edit's requests can pass a megabyte.
  `CREATE TABLE IF NOT EXISTS doc_result (
    version TEXT NOT NULL, edit TEXT NOT NULL, made TEXT NOT NULL, child TEXT,
    result TEXT NOT NULL,
    PRIMARY KEY (version, edit)) STRICT`,
  // The copy of each document: one row a document. `folder` is the Drive folder its last
  // approved read stood on (NULL where no folder session kept it) and `approved` the clock, to
  // the hour, when a scope check last approved a read of it (NULL for a bound Doc's); `made` is
  // the digest the document was last swept under. `bytes` is what the copy holds of the
  // document as fetched, counted as it is stored (`DocCopyHead.bytes`). `outline`, `markers`
  // and `versions` are JSON lists with one entry a tab, in the document's order: its identity,
  // the write markers it held when it was fetched, and the id of its base version.
  `CREATE TABLE IF NOT EXISTS doc_copy (
    doc TEXT PRIMARY KEY, id TEXT NOT NULL, revision TEXT,
    fetched_at INTEGER NOT NULL, checked_at INTEGER, stale INTEGER NOT NULL,
    folder TEXT, approved INTEGER, made TEXT NOT NULL, bytes INTEGER NOT NULL,
    outline TEXT NOT NULL, markers TEXT NOT NULL, versions TEXT NOT NULL
  ) STRICT, WITHOUT ROWID`,
];

// The format the tables above were made and written under: one row.
const FORMAT_TABLE = `CREATE TABLE IF NOT EXISTS doc_format (
  id INTEGER PRIMARY KEY CHECK (id = 0), format TEXT NOT NULL) STRICT`;

/** Every table that holds rows of a document, in the order a change of format removes them. */
const DOCUMENT_TABLES: readonly string[] =
  ["doc_result", "doc_seq", "doc_version", "doc_md", "doc_run", "doc_copy"];

// A version's small row, and a version's runs in order.
const VERSION = "SELECT context, meta FROM doc_version WHERE doc = ? AND id = ?";
const VERSION_DERIVED = "SELECT derived FROM doc_version WHERE doc = ? AND id = ?";
// What the keying of a fetched tab asks of the version beside it, in one row.
const VERSION_KEYS = "SELECT context, derived FROM doc_version WHERE doc = ? AND id = ?";
const PUT_DERIVED = "UPDATE doc_version SET derived = ?3 WHERE doc = ?1 AND id = ?2";
const RUNS = "SELECT run, context, carry, size FROM doc_seq WHERE version = ? ORDER BY seq";
// A page of a version's list from place ?3, ?4 runs at most: each run with the whole summary
// stored with its rendering of digest ?2 in document ?5, NULL where there is none. `summary`
// stands before `md` in its row, so no Markdown is read.
const RUNS_SUMMARISED = `SELECT doc_seq.run, doc_seq.context, doc_seq.carry, doc_seq.size, doc_md.summary
  FROM doc_seq LEFT JOIN doc_md ON doc_md.doc = ?5 AND doc_md.run = doc_seq.run
    AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry AND doc_md.made = ?2
  WHERE doc_seq.version = ?1 AND doc_seq.seq >= ?3 ORDER BY doc_seq.seq LIMIT ?4`;
// A page of a version's list from place ?3: each run's keys and size and, as JSON text, the
// `run` of the summary stored with its rendering of digest ?2 in document ?5: NULL where there
// is none, or where what is stored is not a summary BY `storedSummary`'S RULE (JSON of a record
// with a number `markdownLength`, an array `tables` and a record `run`), so the keying takes a
// run as summarised exactly where a read of the version does. `summary` stands before `md` in
// its row, so no Markdown is read.
const RUNS_KEYED_FROM = `SELECT doc_seq.run, doc_seq.context, doc_seq.carry, doc_seq.size,
    CASE WHEN json_valid(doc_md.summary)
        AND json_type(doc_md.summary, '$.markdownLength') IN ('integer', 'real')
        AND json_type(doc_md.summary, '$.tables') = 'array'
        AND json_type(doc_md.summary, '$.run') = 'object'
      THEN json_extract(doc_md.summary, '$.run') END AS summary
  FROM doc_seq LEFT JOIN doc_md ON doc_md.doc = ?5 AND doc_md.run = doc_seq.run
    AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry AND doc_md.made = ?2
  WHERE doc_seq.version = ?1 AND doc_seq.seq >= ?3 ORDER BY doc_seq.seq LIMIT ?4`;
// A page of a version's list from place ?2 WITH NO JOIN, for a walk that reads no stored
// summary: `summary` is NULL on every row, which says nothing of what is stored. Apart from
// the joined pages because the join looks up a rendering for each run and brings its summary
// to the isolate, some 190 characters a run that such a walk never reads.
const RUNS_FROM = `SELECT run, context, carry, size, NULL AS summary FROM doc_seq
  WHERE version = ?1 AND seq >= ?2 ORDER BY seq LIMIT ?3`;
// A version's totals, in one row: how many runs it lists and the sum of their sizes.
const RUNS_TOTAL =
  "SELECT COUNT(*) AS runs, COALESCE(SUM(size), 0) AS size FROM doc_seq WHERE version = ?";
// The first place at which version ?1 lists an entry (run, context and carry key) that
// version ?2 does not list at the same place: no row where there is none. Steps ?1's list in
// order and looks ?2's entry up at each place, both by the lists' key, and ends at the first
// row it answers: two rows of `doc_seq` a place up to that one, and no content table.
const FIRST_UNLIKE = `SELECT b.seq AS place FROM doc_seq AS b
  LEFT JOIN doc_seq AS a ON a.version = ?2 AND a.seq = b.seq
  WHERE b.version = ?1
    AND (a.seq IS NULL OR a.run <> b.run OR a.context <> b.context OR a.carry <> b.carry)
  ORDER BY b.seq LIMIT 1`;
// The last place, at or after ?4, at which version ?1 lists an entry that version ?2 does not
// list ?3 places later, or whose place ?3 later is before ?4: no row where there is none.
// Steps ?1's list from its end back and looks ?2's entry up for each place, both by the
// lists' key, and ends at the first row it answers: two rows of `doc_seq` a place from the
// list's end back to that one, and no content table.
const LAST_UNLIKE = `SELECT b.seq AS place FROM doc_seq AS b
  LEFT JOIN doc_seq AS a ON a.version = ?2 AND a.seq = b.seq + ?3
  WHERE b.version = ?1 AND b.seq >= ?4
    AND (b.seq + ?3 < ?4 OR a.seq IS NULL OR a.run <> b.run OR a.context <> b.context
      OR a.carry <> b.carry)
  ORDER BY b.seq DESC LIMIT 1`;
// Whether every run version ?1 lists is stored for its document ?2: one row, and `doc_run` is
// reached by its key's index alone, so no content is read.
const RUNS_STORED = `SELECT COUNT(*) AS listed, COUNT(doc_run.id) AS stored
  FROM doc_seq LEFT JOIN doc_run ON doc_run.id = doc_seq.run AND doc_run.doc = ?2
  WHERE doc_seq.version = ?1`;
// A version's run list, written or written over in place, a batch of runs a statement: ?2 is a
// JSON array, one entry a run in order, [run, context, carry, size], and ?3 the place of its
// first run in the version's list.
const PUT_RUNS = `INSERT OR REPLACE INTO doc_seq (version, seq, run, context, carry, size)
  SELECT ?1, ?3 + key, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
    json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?2)`;
// The definitions, in the context ?1 of document ?5, of the lists the runs at places [?3, ?4) of
// version ?2's list name: THE IDS ARE READ OFF THE STORED RUNS INSIDE STORAGE (a paragraph, of
// the body or of a cell, names its list under the key `listId`, and a stored run holds that key
// nowhere else), so no run and no other definition reaches the isolate. A run that is not JSON
// names nothing here; it is found unreadable where it is decoded. For a context `STYLES_OF` said
// holds lists: `json_each` throws on text that is not JSON.
// A CALL IS BILLED a row read for every value of those runs' JSON and for every list the
// context defines, beside the rows of the tables: the price of bringing no run and no
// other definition to the isolate. Where the context defines no list it is billed the
// context's row alone: the runs are read when the first list is asked about, and none is.
const LISTS_NAMED = `SELECT each.key AS id, each.value AS definition
  FROM doc_run, json_each(doc_run.json, '$.lists') AS each
  WHERE doc_run.id = ?1 AND doc_run.doc = ?5 AND each.key IN (
    SELECT tree.value FROM doc_seq JOIN doc_run AS run ON run.id = doc_seq.run AND run.doc = ?5,
      json_tree(CASE WHEN json_valid(run.json) THEN run.json ELSE 'null' END) AS tree
    WHERE doc_seq.version = ?2 AND doc_seq.seq >= ?3 AND doc_seq.seq < ?4
      AND tree.key = 'listId')`;
// The definitions of some lists of the context ?1 of document ?3: only those reach the isolate.
// For a context `STYLES_OF` said holds lists: `json_each` throws on text that is not JSON.
const LISTS_OF = `SELECT each.key AS id, each.value AS definition
  FROM doc_run, json_each(doc_run.json, '$.lists') AS each
  WHERE doc_run.id = ?1 AND doc_run.doc = ?3 AND each.key IN (SELECT value FROM json_each(?2))`;
// The ids of the lists the context ?1 of document ?3 defines that start with ?2, and nothing of
// a definition: the ids the model has made in the tab (`MODEL_LIST_ID`). ONE ROW WITH NO ID for
// a context that defines none, AND NO ROW where the row is missing or is not a context (it is
// not JSON, or its lists are not an object), so the statement answers for the row it reads and
// needs no other before it. The row is read as its JSON, or as NULL where its text is not JSON
// (`CASE`, as `STYLES_OF` has it), and both `json_each` and `json_type` are handed that: neither
// sees text it would throw on, in whatever order the statement's terms are evaluated.
const MODEL_LISTS_OF = `SELECT each.key AS id
  FROM (SELECT CASE WHEN json_valid(json) THEN json END AS json FROM doc_run
      WHERE id = ?1 AND doc = ?3) AS doc_run
    LEFT JOIN json_each(doc_run.json, '$.lists') AS each ON substr(each.key, 1, length(?2)) = ?2
  WHERE json_type(doc_run.json, '$.lists') = 'object'`;
// The sizes of version ?1's runs before place ?2 and of its runs at places [?2, ?3), summed:
// one row, read by the list's key.
const SLICE_SIZES = `SELECT COALESCE(SUM(CASE WHEN seq < ?2 THEN size END), 0) AS before,
    COALESCE(SUM(CASE WHEN seq >= ?2 THEN size END), 0) AS held
  FROM doc_seq WHERE version = ?1 AND seq < ?3`;
// A page of the names of version ?1's runs at places [?2, ?3), ?4 at most, in order.
const RUN_NAMES =
  "SELECT run FROM doc_seq WHERE version = ?1 AND seq >= ?2 AND seq < ?3 ORDER BY seq LIMIT ?4";
// The runs version ?2 lists at places [?3, ?4), as it lists them, written to version ?1's
// list ?5 places later: inside storage, so no entry of them enters the isolate.
const COPY_RUNS = `INSERT OR REPLACE INTO doc_seq (version, seq, run, context, carry, size)
  SELECT ?1, seq + ?5, run, context, carry, size FROM doc_seq
  WHERE version = ?2 AND seq >= ?3 AND seq < ?4`;
// Removes each rendering another digest made under a key version ?1's list holds, in its
// document ?3: found by the renderings' key, so `doc_md` is searched, never scanned. What the
// list is then keyed with is written again under the store's digest.
const DROP_OTHERS_OF = `DELETE FROM doc_md WHERE made <> ?2 AND doc = ?3
  AND (run, context, carry) IN (SELECT run, context, carry FROM doc_seq WHERE version = ?1)`;
// The named styles of the context ?1 of document ?2 and the JSON type of its lists, both NULL
// where the row is not JSON:
// `CASE` evaluates nothing of a branch it does not take, so no JSON function is handed text it
// would throw on.
const STYLES_OF = `SELECT CASE WHEN json_valid(json) THEN json_type(json, '$.lists') END AS lists,
    CASE WHEN json_valid(json) THEN json_extract(json, '$.namedStyles') END AS styles
  FROM doc_run WHERE id = ?1 AND doc = ?2`;
// How many runs one statement writes of a version's list, and one page of it reads. One bound
// value is held to a row's limit (`DOC_ROW_BYTES`) and a list grows with the tab: a tab of the
// smallest tables, each with the paragraph that must stand between two, is tens of thousands of
// runs. An entry is two names of 64 characters, a size and a carry key, about 150 bytes where
// the key is '', so a batch is about 75 KB of those; and the carry keys of a whole tab are
// under a sixth of its JSON (a key holds a number, some 25 characters, only for a list item of
// its run, 150 characters at least), under 2 MiB for the largest answer Google sends. So a
// batch is under 2.5 MB whatever the tab, and the limit is never met.
const RUN_LIST_BATCH = 500;
// The runs the first page of a reader asks for (`DocStore.reader`), each page after it four
// times as many, up to a full page: a reader is asked for the few runs in which two versions
// differ far more often than for a list, and a page is read whole, each run with the summary
// of its rendering, some 600 characters a run.
const RUN_LIST_FIRST = 8;
// WHAT ONLY DEAD VERSIONS LIST, removed inside storage: of document ?1, the renderings, the
// runs and the contexts that a version of ?2 (a JSON array of ids, the dead) names and no
// version of ?3 (the live) does. Each reads the dead and the live versions' lists (their
// records, for the contexts) by their key, once, into two sets of what they name that storage
// holds in its own memory, ONE ENTRY A DISTINCT NAME, however many versions list it; the
// content table is then searched by its key for each name of the dead, and a row goes where
// the live do not hold its name. No row reaches the isolate. Run while the dead versions'
// lists are whole. (Grouping the two lists together instead sorts a row for every run of
// every list: beside fifty live versions of a tab of 19,601 runs that is a million rows,
// some 90 MiB of storage's memory, where these sets are under 5.)
const RENDERINGS_OF_DEAD = `DELETE FROM doc_md WHERE doc = ?1
  AND (run, context, carry) IN (
    SELECT run, context, carry FROM doc_seq WHERE version IN (SELECT value FROM json_each(?2)))
  AND (run, context, carry) NOT IN (
    SELECT run, context, carry FROM doc_seq WHERE version IN (SELECT value FROM json_each(?3)))`;
const RUNS_OF_DEAD = `DELETE FROM doc_run WHERE doc = ?1
  AND id IN (SELECT run FROM doc_seq WHERE version IN (SELECT value FROM json_each(?2)))
  AND id NOT IN (SELECT run FROM doc_seq WHERE version IN (SELECT value FROM json_each(?3)))`;
const CONTEXTS_OF_DEAD = `DELETE FROM doc_run WHERE doc = ?1
  AND id IN (
    SELECT context FROM doc_version WHERE doc = ?1 AND id IN (SELECT value FROM json_each(?2)))
  AND id NOT IN (
    SELECT context FROM doc_version WHERE doc = ?1 AND id IN (SELECT value FROM json_each(?3)))`;
// A run or a context by its name and its document, and a rendering by its key: a statement
// made of `MARKDOWN_KEY` binds what it adds after the key, and the document last (`IN_DOC`).
const RUN_FOUND = "SELECT 1 AS found FROM doc_run WHERE id = ? AND doc = ?";
const RUN_JSON = "SELECT json FROM doc_run WHERE id = ? AND doc = ?";
const MARKDOWN_KEY = "FROM doc_md WHERE run = ? AND context = ? AND carry = ?";
const IN_DOC = "AND doc = ?";
const RESULT_KEY = "FROM doc_result WHERE version = ? AND edit = ?";

type VersionRow = { context: string; meta: string };
type RunRow = { run: string; context: string; carry: string; size: number };
/** What names a version's rows: its document, which keys its runs and renderings, and its id. */
type VersionKey = Pick<DocVersion, "doc" | "id">;
type KeyRow = { run: string; context: string; carry: string };
/** What `doc_md.summary` holds: what readers ask of the run's rendering, and the renderer's summary. */
type StoredRunSummary = DocRunSummary & { readonly run: RunSummary };
/** A run of a version's list with the summary of its stored rendering. */
type KeyedRun = RunRow & { readonly summary: StoredRunSummary };
/**
 * A version's runs for a read, pulled one a call (`DocStore`'s `#keyedRuns`): `next` answers
 * the run at the next place, `undefined` once the list is passed, and `false` where a run
 * rendered alone shows that the list is not what this code makes of the version. `alone`
 * renders the run in hand alone, once, and `place` is that run's place.
 */
type KeyedRuns = {
  next(): KeyedRun | undefined | false;
  alone(): RenderedRun | undefined;
  readonly place: number;
};
/** One run of a tab in hand, as `tabParts` cut it: its name, and what `CutRun` says of it. */
type RunInHand = Pick<CutRun, "size" | "elements" | "holds"> & { readonly id: string };
/** What the keying of a tab's runs carries from one run to the next: one pass's state. */
type Keying = {
  /** The document whose runs the pass keys: a rendering is read and written as its row. */
  readonly doc: string;
  /** What the renderer carries into the next run, TO READ: moved by `passed` alone. */
  readonly carry: RenderCarry;
  /** The next run's first index. */
  first: number;
  /**
   * What moves `carry`: the pass's own carry (the same object as `carry`), or, where the
   * pass holds another version's carry beside its own, the pair (`besideOf`).
   */
  mover: PassCarry | CarryBeside;
};

// The state of a pass over a tab of document `doc` at the tab's first run, whose first index is
// `first`: a carry of the pass's own. A PASS OWNS ITS CARRY AND MOVES IT IN PLACE: whoever is
// handed `carry` reads it before the pass moves again and keeps nothing of it but a copy of what
// it needs (a run's key, a number).
function keyingFrom(doc: string, first: number): Keying {
  let carry = initialCarry();
  return { doc, carry, first, mover: carry };
}

// Moves `state` past a run of `size` whose summary is `summary`: THE ONE PLACE a keying
// pass's carry moves, after the caller has taken of it what the run's key needs
// (`advanceCarry` of the pass's own carry, or the pair's `advanceOurs`).
function passed(state: Keying, summary: RunSummary, size: number): void {
  if (state.mover instanceof CarryBeside) state.mover.advanceOurs(summary);
  else advanceCarry(state.mover, summary);
  state.first += size;
}

// Another version's carry beside `state`'s, from this run on: the two are the same carry at
// this moment. Made once a pass, of the pass's carry and a carry made for the pair
// (`new CarryBeside(pass, initialCarry())`); `state` moves through it from here on.
function besideOf(state: Keying): CarryBeside {
  let pass = state.mover;
  if (pass instanceof CarryBeside) throw new Error("A pass holds one carry beside its own.");
  let beside = new CarryBeside(pass, initialCarry());
  state.mover = beside;
  return beside;
}
/** What a run's rendering reads of its tab, and the tab's id for an error that names it. */
type Named = { readonly tabId: string } & RenderContext;
// A run of a version's list as a page of it answers it: its keys, its size and THE TEXT of a
// summary as storage answers it (which one is the page's choice; NULL where there is none,
// and on every row of a page read with no join). Not parsed here: who reads a summary parses
// the one it reads (`summaryOf`, `storedSummary`), so a page of the list holds no parsed
// summary.
type ListedRun = RunRow & { readonly summary: string | null };
// A version's list as a walk reads it, EACH RUN ONCE AND IN ORDER: answers the run at the
// next place, and `undefined` once the list has ended.
type ListReader = () => ListedRun | undefined;
// What the stored runs of ONE WALK of a version's list are rendered with: asked once a run,
// with the run's place in the list and its elements decoded. Answers the context's named
// styles and, parsed, the definitions of the lists `elements` name (`namedListIds`), as own
// properties: a list the tab does not define is absent. `undefined` where the context is
// missing or is not one, or a definition is not a record.
type RunContexts =
  (place: number, elements: readonly StructuralElement[]) => RenderContext | undefined;
// Which runs of a version a slice takes, decided as the list's rows pass: `low` and `high`
// are indexes of the tab, `from` and `to` places of the list. It starts at the earlier of
// place `from` and the run that holds `low`, one run earlier where an index of `behind` is
// the first index of that run, and ends after the later of place `to - 1` and the run that
// holds `high`. The run that holds an index is the last whose first index is not past it:
// the first run for an index before the tab, the last for one at or past its end.
type SlicePick = {
  readonly low?: number;
  readonly high?: number;
  readonly from?: number;
  readonly to?: number;
  readonly behind: readonly number[];
};
/**
 * What the keying walk holds of one run `like` lists, by its place counted from where the
 * walk took `like` up.
 */
type RunBeside = {
  /** The places the version lists the run at, in order. */
  readonly places: number[];
  /** How many of them the walk has passed: it only moves forward. */
  passed: number;
  /** The context key the version lists for the run, and the carry keys. */
  readonly context: string;
  readonly carries: Set<string>;
  /** The summary stored with a rendering of the run: the same at every place. */
  readonly summary: RunSummary;
};
/**
 * What the keying walk holds of `like` from the place it took it up: each run's carry key
 * and the renderer's summary of it, in order, and each of its runs by id.
 */
type Beside = {
  readonly theirs: readonly { readonly carry: string; readonly summary: RunSummary }[];
  readonly known: ReadonlyMap<string, RunBeside>;
};
type CopyRow = {
  id: string; revision: string | null; fetched_at: number; checked_at: number | null;
  stale: number; folder: string | null; approved: number | null; made: string;
  bytes: number; outline: string; markers: string; versions: string;
};

/** What a version's row holds of its tab. Its keys, in this order, are part of the version's id. */
type VersionMeta = { tabId: string; bodyEndIndex: number; exact: boolean };

/** The identity and the write markers a handle is given: neither is stored with its version. */
type HandleOf = GoogleDocTabIdentity & { readonly writeMarkers: readonly DocWriteMarkerCopy[] };

/** `text` parsed, or `undefined` where it is not JSON. The parser's message quotes its input. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A list's definition as a statement over a context answers it (JSON text), parsed:
// `undefined` where it is not a record.
function listDefined(definition: SqlStorageValue | undefined): Record<string, unknown> | undefined {
  let defined = typeof definition === "string" ? parsed(definition) : undefined;
  return isRecord(defined) ? defined : undefined;
}

function versionMeta(text: string): VersionMeta | undefined {
  let meta = parsed(text);
  return isRecord(meta) && typeof meta.tabId === "string" && typeof meta.bodyEndIndex === "number" &&
    typeof meta.exact === "boolean"
    ? { tabId: meta.tabId, bodyEndIndex: meta.bodyEndIndex, exact: meta.exact }
    : undefined;
}

/** What code worked out of a version's tab: whether the model cannot follow it, and its keys. */
type Derived = { readonly unindexed?: boolean; readonly keyed?: true };

/** What `derived` says where `made` worked it out, and `undefined` where other code did. */
function derivedUnder(derived: string, made: string): Derived | undefined {
  let value = parsed(derived);
  if (!isRecord(value) || value.made !== made) return undefined;
  return {
    ...(typeof value.unindexed === "boolean" ? { unindexed: value.unindexed } : {}),
    ...(value.keyed === true ? { keyed: true } : {}),
  };
}

function handle(doc: string, id: string, meta: VersionMeta, as: HandleOf): DocVersion {
  return {
    ...tabIdentity(as), id, doc, bodyEndIndex: meta.bodyEndIndex, exact: meta.exact,
    writeMarkers: as.writeMarkers,
  };
}

function markersOf(writeMarkers: readonly DocWriteMarkerCopy[]): DocWriteMarkerCopy[] {
  return writeMarkers.map(({ writeId, id }) => ({ writeId, id }));
}

/**
 * The parts `tab` is stored as in document `doc`, and the id of the version they make: the one
 * place a tab is cut into runs (`cutRuns`) and each run named, so the tab that is stored and
 * the tab that is named cannot differ. One run's JSON is in hand at a time: `each` is handed
 * each run as it is cut, with its name, and the string is let go when it returns. Nothing
 * derived is in the id but `exact` and where the runs are cut, and neither is what the tab is
 * called, where it stands or its write markers.
 */
function tabParts(
  doc: string, tab: GoogleDocsTab, sizes: RunSizes, each?: (run: CutRun, id: string) => void,
) {
  let content = tab.body.content;
  // The tab's first index, as the cut counts it.
  let opening = content[0]?.startIndex;
  let first = Number.isInteger(opening) ? opening : 0;
  let runs: RunInHand[] = [];
  let size = 0;
  for (let run of cutRuns(content, sizes)) {
    runInHand(run.json);
    let id = runId(run.json);
    each?.(run, id);
    runs.push({ id, size: run.size, elements: run.elements, holds: run.holds });
    size += run.size;
  }
  let { json: context, key: contextKey } = contextOf(tab);
  // Where the last run ends: the end index of the body's last element where it holds one.
  let meta: VersionMeta = {
    tabId: tab.tabId, bodyEndIndex: first + size, exact: isModelIndexed(tab),
  };
  return {
    runs, context, contextKey, meta, first,
    id: versionName(doc, meta, contextKey, runs.map(({ id }) => id)),
  };
}

// A tab's context as it is stored, and its name: the one definition, for a tab in hand
// (`tabParts`) and a fetched one. The JSON is `{ lists, namedStyles? }` in that key order.
function contextOf(
  context: Pick<GoogleDocsTab, "lists" | "namedStyles">,
): { json: string; key: string } {
  let json = JSON.stringify({
    lists: context.lists, ...(context.namedStyles ? { namedStyles: context.namedStyles } : {}),
  });
  return { json, key: runId(json) };
}

// The name of a version as its runs' names pass: `add` each run's name in order, then `end`
// answers `runId(JSON.stringify([doc, meta, contextKey, runs]))` of those names, to the same
// bytes, with no list of the names made: the hash is fed that text piece by piece, each piece
// whole JSON values and the punctuation between them.
function versionNamer(
  doc: string, meta: VersionMeta, contextKey: string,
): { add(run: string): void; end(): string } {
  let hash = createHash("sha256");
  hash.update(`${JSON.stringify([doc, meta, contextKey]).slice(0, -1)},[`, "utf8");
  let named = false;
  return {
    add(run) {
      hash.update(`${named ? "," : ""}${JSON.stringify(run)}`, "utf8");
      named = true;
    },
    end: () => hash.update("]]", "utf8").digest("hex"),
  };
}

// The id of the version of document `doc` that `meta`, a context's name and the runs' names
// make: the one definition (`tabParts`, `readTab`), by `versionNamer`.
function versionName(
  doc: string, meta: VersionMeta, contextKey: string, runs: readonly string[],
): string {
  let name = versionNamer(doc, meta, contextKey);
  for (let run of runs) name.add(run);
  return name.end();
}

// ONE READ OF A FETCHED TAB, to its end. FIRST the context, which the caller has in hand
// before the first run, is checked against a row's size (`requireRow`): a tab whose lists are
// past a row is refused before any run of it is read, rendered, packed or written. Then each
// run, as `tab.runs` yields it: counted in hand (`runInHand`, and `inHand` moved by its
// string), named (`runId`), CHECKED AGAINST A ROW'S SIZE (`requireRow` of its name and its
// JSON: an element past a row is refused before it is rendered, packed or written), and
// handed to `each`, before the next element is read. The answer is what is known at the
// tab's end.
// Writes nothing, reads nothing of storage, and takes nothing off `inHand`: `each` does. It
// keeps, from one run to the next, the runs' names and the size so far.
function readTab(
  doc: string, tab: FetchedDocTab, context: { json: string; key: string }, inHand: InHand,
  each: (run: CutRun, id: string) => void,
): { meta: VersionMeta; id: string; unindexed: boolean } {
  let { tabId } = tab.identity;
  requireRow(listsNamed(tabId), context.key, context.json);
  let ids: string[] = [];
  let size = 0;
  for (let run of tab.runs) {
    runInHand(run.json);
    inHandBy(inHand, 2 * run.json.length);
    let id = runId(run.json);
    requireRow(runNamed(tabId, run.holds), id, run.json);
    each(run, id);
    ids.push(id);
    size += run.size;
  }
  // A fetched tab is never one the model made.
  let meta: VersionMeta = { tabId, bodyEndIndex: tab.first + size, exact: false };
  return { meta, id: versionName(doc, meta, context.key, ids), unindexed: tab.unindexed() };
}

/** The name of a copy: the same for the same revision, versions, outline and markers. */
function copyName(
  revision: string | undefined, versions: readonly string[],
  outline: readonly GoogleDocTabIdentity[], markers: readonly (readonly DocWriteMarkerCopy[])[],
): string {
  return runId(JSON.stringify([revision ?? null, versions, outline, markers]));
}

/** The grain of `DOC_COPY_APPROVAL_GRAIN_MS` the clock `at` is in. */
export function approvalHour(at: number): number {
  return at - at % DOC_COPY_APPROVAL_GRAIN_MS;
}

/** The first index of `version`'s tab: where its body ends less the sizes of the runs it lists. */
function firstIndex(version: DocVersion, runs: readonly { readonly size: number }[]): number {
  return version.bodyEndIndex - runs.reduce((sum, { size }) => sum + size, 0);
}

/**
 * The context key of a run as its version's list holds it, from the renderer's summary of the
 * run: what the run reads of `context` (`runContextKey`), named by its hash, and '' where the
 * run reads nothing of it.
 */
function listedContext(summary: RunSummary, context: RenderContext): string {
  let key = runContextKey(summary, context);
  return key === "" ? "" : runId(key);
}

/**
 * The entry of a run in its version's list: the keys its rendering is stored under, from the
 * renderer's summary of the run, what the run reads of `context` and the carry it is entered
 * with.
 */
function listEntry(
  run: string, size: number, summary: RunSummary, context: RenderContext, carry: RenderCarry,
): RunRow {
  return {
    run, context: listedContext(summary, context), carry: runCarryKey(summary, carry), size,
  };
}

/** What is kept of `rendering` beside its Markdown; `first` is its run's first index. */
function summarise(
  rendering: Pick<DocTabSnapshot, "markdown" | "sourceMap">, first: number,
): DocRunSummary {
  let { markdown, sourceMap } = rendering;
  return {
    markdownLength: markdown.length,
    blank: isBlankDocTab(rendering),
    blocks: sourceMap.blocks.length,
    protectedRanges: sourceMap.protectedRanges.length,
    numberedItems: sourceMap.blocks.some(block => block.listType === "numbered"),
    tables: sourceMap.tables.map(table => {
      let html = markdown.slice(table.mdStart, table.mdEnd);
      return {
        start: table.docStart - first,
        shape: runId(tableShape(html)),
        cells: tableCellCount(html),
        numbered: html.includes("<ol"),
        mdStart: table.mdStart,
        mdEnd: table.mdEnd,
      };
    }),
  };
}

/** What `doc_md.summary` holds of `rendered`, one run's rendering; `first` is the run's first index. */
function keptSummary(rendered: RenderedRun, first: number): StoredRunSummary {
  return { ...summarise(rendered, first), run: rendered.summary };
}

// What `doc_md.md` begins with where it holds the JSON of its Markdown.
const MARKDOWN_AS_JSON = "\u0001";

/**
 * `markdown` as `doc_md.md` holds it. SQLite's TEXT is UTF-8, which has no half of a surrogate
 * pair: one bound as it is reads back as three U+FFFD, a Markdown other than the one its
 * summary measured. Markdown that holds one (text cut inside an emoji) is stored as its JSON,
 * which escapes it, behind a mark; so is Markdown that begins with the mark.
 */
function markdownAsStored(markdown: string): string {
  return markdown.isWellFormed() && !markdown.startsWith(MARKDOWN_AS_JSON)
    ? markdown
    : MARKDOWN_AS_JSON + JSON.stringify(markdown);
}

/** The Markdown `markdownAsStored` stored as `text`, or `undefined` where `text` is not one. */
function markdownFromStored(text: string): string | undefined {
  if (!text.startsWith(MARKDOWN_AS_JSON)) return text;
  let markdown = parsed(text.slice(MARKDOWN_AS_JSON.length));
  return typeof markdown === "string" ? markdown : undefined;
}

function storedSummary(text: string): StoredRunSummary | undefined {
  let summary = parsed(text);
  return isRecord(summary) && typeof summary.markdownLength === "number" &&
    Array.isArray(summary.tables) && isRecord(summary.run)
    ? summary as StoredRunSummary
    : undefined;
}

// The renderer's summary of a listed run: `undefined` where none is stored or what is stored
// is no summary (the statement that listed the run answers NULL for both).
function summaryOf(run: ListedRun): RunSummary | undefined {
  let summary = typeof run.summary === "string" ? parsed(run.summary) : undefined;
  return isRecord(summary) ? summary as RunSummary : undefined;
}

// The run a walk or a reader hands: `run` at `place`, with `markdown` its read of the run's
// stored Markdown and `elements` its decode. `entry` is made where it is asked, so a walk that
// never asks makes none.
function storedRun(
  run: KeyedRun, place: number, markdown: () => string, elements: StoredRun["elements"],
): StoredRun {
  return {
    place, size: run.size, summary: run.summary, markdown, content: run.run, elements,
    get entry() {
      return `${run.run} ${run.context} ${run.carry}`;
    },
  };
}

/**
 * The summaries of a version's runs as one, for any number of runs, TAKEN A RUN AT A TIME:
 * `add` is handed each run in order and `end` answers the whole. Made of the fields of
 * `DocRunSummary` and no other, so what a stored summary holds beside them stays in the
 * store. It holds its answer, which lists every table of the tab, and nothing of a run.
 */
function summaryJoiner(): { add(run: KeyedRun): void; end(): DocRunSummary } {
  let markdownLength = 0, blocks = 0, protectedRanges = 0, start = 0;
  let blank = true, numberedItems = false;
  let tables: DocTableSummary[] = [];
  return {
    add({ summary, size }) {
      for (let table of summary.tables) {
        tables.push({
          ...table, start: table.start + start,
          mdStart: table.mdStart + markdownLength, mdEnd: table.mdEnd + markdownLength,
        });
      }
      markdownLength += summary.markdownLength;
      blocks += summary.blocks;
      protectedRanges += summary.protectedRanges;
      start += size;
      if (!summary.blank) blank = false;
      if (summary.numberedItems) numberedItems = true;
    },
    // Blank is said of a whole rendering: Markdown of one empty line and nothing protected.
    end: () => ({
      markdownLength, blocks, protectedRanges, tables,
      blank: markdownLength <= 1 && blank, numberedItems,
    }),
  };
}

// ---------------------------------------------------------------------------
// A piece of a stored tab
// ---------------------------------------------------------------------------

// What `#rendered` notes of the elements of the runs it renders, where it is asked: where
// each starts and ends in the tab, as numbers. An element whose index is no integer starts
// or ends where the element before it ends (the run's first index for a run's first), as
// `CutRun.size` has it.
type ElementIndexes = { readonly starts: number[]; readonly ends: number[] };

// The first of the own elements `at` names among `told`, the elements of the run it names
// rendered with its Markdown placed at `mdStart`: -1 where the run holds none of them.
function ownFirstIn(told: RunElements, at: PieceAt, mdStart: number): number {
  let { own } = at;
  if (own === "end") return told.flags.length - 1;
  if ("table" in own) {
    let before = own.table - at.tablesBefore;
    for (let element = 0; element < told.flags.length; element++) {
      if (told.flags[element] & ELEMENT_TABLE && before-- === 0) return element;
    }
    return -1;
  }
  let target = mdStart + own.markdown.mdStart - at.mdStart;
  let element = told.starts.length - 1;
  while (element >= 0 && told.starts[element] > target) element--;
  return element;
}

// The flags of the elements of the runs a scout renders (`RunElements.flags`), gathered a
// run at a time in ONE array that doubles as it fills: a byte an element, and under two
// with the room it grows into. No array is kept for a run.
function flagsGathered(): { add(flags: Uint8Array): void; all(): Uint8Array } {
  let held = new Uint8Array(64);
  let length = 0;
  return {
    add(flags) {
      if (length + flags.length > held.length) {
        let grown = new Uint8Array(Math.max(2 * held.length, length + flags.length));
        grown.set(held.subarray(0, length));
        held = grown;
      }
      held.set(flags, length);
      length += flags.length;
    },
    all: () => held.subarray(0, length),
  };
}

// ---------------------------------------------------------------------------
// A fetched document, in hand
// ---------------------------------------------------------------------------

// One place a run in hand is rendered: `renderRun` with `carry`, counted (`runsRendered`), and
// what the renderer throws thrown as a `DocRunRenderError`.
function renderedInHand(
  elements: readonly StructuralElement[], context: RenderContext, carry: RenderCarry,
): RenderedRun {
  let rendered: RenderedRun;
  try {
    rendered = renderRun(elements, context, carry, { mdStart: 0 });
  } catch (thrown) {
    throw new DocRunRenderError(thrown);
  }
  docStoreCost.runsRendered++;
  return rendered;
}

// What `render` answers of a stored run. Where `marked`, what the renderer throws is thrown
// as a `DocRunRenderError`: the read is made for an edit (`DocStore.walk`, `DocStore.piece`),
// whose refusal the renderer's throw is. Otherwise it passes as it is: a read is outside any
// edit.
function renderedStored(marked: boolean, render: () => RenderedRun): RenderedRun {
  if (!marked) return render();
  try {
    return render();
  } catch (thrown) {
    throw new DocRunRenderError(thrown);
  }
}

/**
 * The Markdown of `tab`: each run rendered from its elements with the carry of the one before
 * and joined in order, which is what `DocStore.markdown` answers of the tab's version once it
 * is stored. Reads `tab.runs` to its end, one run in hand at a time; stores nothing. A pass of
 * its own: it owns its carry and moves it in place past each run.
 * @throws `DocRunRenderError` where the renderer throws on a run.
 */
export function fetchedMarkdown(tab: FetchedDocTab): string {
  let { context } = tab;
  let carry = initialCarry();
  let pieces: string[] = [];
  for (let run of tab.runs) {
    let rendered = renderedInHand(run.elements, context, carry);
    pieces.push(rendered.markdown);
    advanceCarry(carry, rendered.summary);
  }
  let markdown = pieces.length === 1 ? pieces[0] : pieces.join("");
  markdownInHand(markdown);
  return markdown;
}

// How many bytes a chunk of a held document holds, and a frame's head.
const HELD_CHUNK_BYTES = 1 << 20;
const HELD_HEAD_BYTES = 12;

// A row's TEXT as the bytes storage holds, and back. The reader keeps a leading U+FEFF (a part
// of a frame may begin with one) and throws on bytes that are not UTF-8 rather than mending them.
const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Where a frame starts: the chunk, by its place in the list, and the byte in it.
type HeldPlace = { readonly chunk: number; readonly at: number };

// THE PACK a held document's bytes are written to: FRAMES in the order they are added, in
// chunks of HELD_CHUNK_BYTES. A frame is a head of HELD_HEAD_BYTES (as `DataView` writes
// them: the bytes of its text, an unsigned 32-bit integer, and then a number of its writer's
// as a 64-bit float, which holds ANY number a run's size can be, so a document the store
// keeps is one this holds) and then its text as UTF-8. A head is never split between two
// chunks: where fewer than HELD_HEAD_BYTES are left the next chunk is begun. A text is split,
// ON A CHARACTER (`TextEncoder.encodeInto` writes whole characters and says how far it
// read), so each part decodes alone. So every chunk but the last holds more than
// HELD_CHUNK_BYTES - HELD_HEAD_BYTES bytes (fewer than a head were left, or fewer than the
// four of a character). A chunk in the list is a view of exactly the bytes used: the chunks'
// lengths sum to the frames' bytes, heads included, with nothing over.
function heldPack() {
  let chunks: Uint8Array[] = [];
  let chunk: Uint8Array | undefined;
  let at = 0;
  let bytes = 0;
  // Closes the chunk that is open, where one is, and opens the next.
  let open = (): Uint8Array => {
    if (chunk) chunks.push(chunk.subarray(0, at));
    at = 0;
    return chunk = new Uint8Array(HELD_CHUNK_BYTES);
  };
  return {
    // Adds a frame and answers where it starts.
    add(text: string, number: number): HeldPlace {
      let into = chunk === undefined || HELD_CHUNK_BYTES - at < HELD_HEAD_BYTES ? open() : chunk;
      let place: HeldPlace = { chunk: chunks.length, at };
      let head = new DataView(into.buffer, at, HELD_HEAD_BYTES);
      at += HELD_HEAD_BYTES;
      let length = 0;
      for (let rest = text; ;) {
        let { read, written } = UTF8.encodeInto(rest, into.subarray(at));
        at += written;
        length += written;
        if (read === rest.length) break;
        rest = rest.slice(read);
        into = open();
      }
      head.setUint32(0, length);
      head.setFloat64(4, number);
      bytes += HELD_HEAD_BYTES + length;
      return place;
    },
    // The bytes of the frames added so far, heads included.
    get bytes(): number {
      return bytes;
    },
    // The chunks, the last cut to the bytes it holds (a copy of at most one chunk). Called
    // once, after the last `add`.
    done(): Uint8Array[] {
      if (chunk) chunks.push(chunk.slice(0, at));
      chunk = undefined;
      return chunks;
    },
  };
}

// The `count` frames from `from`, in order, each read back when it is asked for and kept by
// nothing here: a part of a text that passed a chunk's end is decoded alone and joined.
function* heldFrames(
  chunks: readonly Uint8Array[], from: HeldPlace, count: number,
): Generator<{ text: string; number: number }> {
  let { chunk: index, at } = from;
  // Reads the frame at the place reached and moves past it: its locals are gone when it
  // returns, so the generator holds the place alone from one frame to the next.
  let frame = () => {
    let chunk = chunks[index];
    if (at === chunk.length) {
      chunk = chunks[++index];
      at = 0;
    }
    let head = new DataView(chunk.buffer, chunk.byteOffset + at, HELD_HEAD_BYTES);
    let left = head.getUint32(0);
    let number = head.getFloat64(4);
    at += HELD_HEAD_BYTES;
    let text = "";
    while (left > 0) {
      if (at === chunk.length) {
        chunk = chunks[++index];
        at = 0;
      }
      let take = Math.min(left, chunk.length - at);
      text += FROM_UTF8.decode(chunk.subarray(at, at + take));
      at += take;
      left -= take;
    }
    return { text, number };
  };
  for (let read = 0; read < count; read++) yield frame();
}

// What a held document keeps of one tab beside the pack: where its runs' frames start and how
// many they are, where its context's frame is, and what was known of the tab when it was read.
type HeldTabRecord = Pick<FetchedDocTab, "identity" | "writeMarkers" | "first"> & {
  readonly bodyEndIndex: number;
  readonly unindexed: boolean;
  readonly runs: HeldPlace;
  readonly count: number;
  readonly context: HeldPlace;
};

// The next run of a held tab, decoded alone from the next of `frames` at `at`, which is moved
// past it. The run it answers is its caller's: nothing here keeps it.
function heldRun(
  frames: Iterator<{ text: string; number: number }>, at: { first: number; footnotes: number },
): CutRun {
  let { text: json, number: size } = frames.next().value as { text: string; number: number };
  let decoded = decodeRun(json, { ...at, exact: false });
  if (decoded === undefined) throw new Error("A held run of a Google Doc did not read back.");
  docStoreCost.runsDecoded++;
  at.first += size;
  at.footnotes += decoded.footnotes;
  return {
    json, elements: decoded.elements, size, footnotes: decoded.footnotes,
    holds: heldBy(decoded.elements),
  };
}

// The runs of the held tab `record`, read back from `chunks` one at a time. The generator
// holds the frames' reader and two numbers from one run to the next.
function* heldRuns(chunks: readonly Uint8Array[], record: HeldTabRecord): Generator<CutRun> {
  let frames = heldFrames(chunks, record.runs, record.count);
  let at = { first: record.first, footnotes: 0 };
  for (let read = 0; read < record.count; read++) yield heldRun(frames, at);
}

/**
 * One tab of a held document: a `FetchedDocTab` that can be read again, and where its body
 * ends. `context` parses the tab's stored context at each read and `runs` decodes the tab's
 * runs anew at each iteration, one at a time, each alone from its bytes (`decodeRun`):
 * nothing a read makes is kept by the tab.
 */
export type HeldDocTab = FetchedDocTab & {
  /** Where the tab's body ends: its first index and the sizes of its runs. */
  readonly bodyEndIndex: number;
};

/**
 * A fetched document read to its end and held, for a read that may not store it yet: THE
 * LEAST THE STORE NEEDS TO KEEP IT, and nothing of the answer it was read from. It holds every
 * run's stored JSON as its UTF-8, in the document's order, in chunks of `HELD_CHUNK_BYTES`
 * that its tabs share, each run behind a head of 12 bytes; each tab's context the same way;
 * and of each tab its identity, its write markers and a few numbers. NOTHING DERIVED: no
 * Markdown, no summary, no key and no name of a run. So it takes the bytes of its runs' JSON,
 * which is at most about the bytes of Google's answer, and 12 bytes a run, whatever the
 * document's script (a string would take two bytes a character once it held one character
 * outside Latin-1).
 *
 * It is a `FetchedDoc` whose tabs can be read again, so `DocStore.trial` and `DocStore.keep`
 * store it by the pass that stores a document as it is read: each run is decoded alone from
 * its bytes, named, keyed beside the stored copy and rendered where no rendering is stored,
 * written and let go. Each such pass decodes every run and renders what the store lacks:
 * a first read through Drive, a trial and then a keep, renders each run twice.
 */
export type HeldDoc = Omit<FetchedDoc, "tabs"> & {
  /** The document's key in the store it was held for (part of each version's id). */
  readonly doc: string;
  /** The id `DocStore.keep(doc, ...)` gives the copy's record (`copyName`). */
  readonly id: string;
  /** The tabs in the document's order. */
  readonly tabs: readonly HeldDocTab[];
  /**
   * The chunks the document's bytes are packed in, in order: what it weighs. Each is a view
   * of exactly the bytes it holds, and its tabs read their runs back from them.
   */
  readonly chunks: readonly Uint8Array[];
};

// The held tab of `record`, over the pack's `chunks`: it closes over those two and nothing else.
function heldTab(chunks: readonly Uint8Array[], record: HeldTabRecord): HeldDocTab {
  return {
    identity: record.identity,
    writeMarkers: record.writeMarkers,
    first: record.first,
    bodyEndIndex: record.bodyEndIndex,
    get context() {
      let [frame] = heldFrames(chunks, record.context, 1);
      return JSON.parse(frame.text) as FetchedDocTab["context"];
    },
    runs: { [Symbol.iterator]: () => heldRuns(chunks, record) },
    unindexed: () => record.unindexed,
  };
}

/**
 * Reads `document` to its end and holds it as document `doc`'s (`HeldDoc`): each run is cut,
 * checked against a row's size, named (for the copy's id) and packed as bytes; nothing is
 * rendered, read from storage or written. The elements of a document of `fetchedDoc` are let
 * go as its runs are read, and each run's string once it is packed, so what is in hand when
 * this returns is the held document. While a tab is read its runs' names are in hand too (a
 * string of 64 characters a run), until its end.
 * @throws What reading `document.tabs` throws (`fetchedDoc`), and `DocRowTooLargeError` for an
 * element or a tab's context too large for a row: such a document is refused here, before a
 * read waits with it.
 */
export function heldDoc(doc: string, document: FetchedDoc): HeldDoc {
  let pack = heldPack();
  let inHand: InHand = { bytes: 0 };
  let records: HeldTabRecord[] = [];
  let versions: string[] = [];
  for (let tab of document.tabs) {
    let context = contextOf(tab.context);
    // Where the tab's first run is packed, and how many runs are.
    let packed: { first?: HeldPlace; count: number } = { count: 0 };
    let end = readTab(doc, tab, context, inHand, run => {
      let before = pack.bytes;
      let place = pack.add(run.json, run.size);
      packed.first ??= place;
      packed.count++;
      // The string and its bytes are both in hand here; then the string is let go.
      inHandBy(inHand, pack.bytes - before);
      inHandBy(inHand, -2 * run.json.length);
    });
    let stored = pack.add(context.json, 0);
    records.push({
      identity: tab.identity, writeMarkers: markersOf(tab.writeMarkers), first: tab.first,
      bodyEndIndex: end.meta.bodyEndIndex, unindexed: end.unindexed,
      // A body is at least one run, so a tab's runs have a place.
      runs: packed.first ?? stored, count: packed.count, context: stored,
    });
    versions.push(end.id);
  }
  let chunks = pack.done();
  return {
    ...(document.revision === undefined ? {} : { revision: document.revision }),
    fetchedAt: document.fetchedAt,
    doc,
    id: copyName(
      document.revision, versions, records.map(({ identity }) => identity),
      records.map(({ writeMarkers }) => writeMarkers),
    ),
    tabs: records.map(record => heldTab(chunks, record)),
    chunks,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * A Google Doc's copy, each pending edit's result and each rendering, kept in a Durable
 * Object's SQLite: storage is the working state and a caller holds the piece in hand. A tab is
 * a version: an ordered list of immutable runs named by their content, and the tab's small
 * data. A run is consecutive elements of the tab's body, cut by content (`cutRuns`), with every
 * position counted from its own start, and is rendered alone: its Markdown is stored under the
 * run, what the run reads of the tab's lists and what it shows of the state the renderer
 * carries into it, when the version is stored. So a read joins stored Markdown, and an edit
 * takes in hand the rendering of the piece of its tab around it (`piece`) and the runs its
 * batch touches (`slice`), never the tab's elements whole: it makes a child version that lists
 * the runs cut from those in their place and every other run as it was, and renders the
 * runs cut (`putSlice`); rejecting or approving an edit is choosing
 * another version. The store keeps NOTHING in memory between two calls: no decoded tab, no
 * rendering, no handle, but how many runs a tab still in a caller's hand is, weakly.
 *
 * Two rules its callers keep. (1) A `DocVersion` is valid only until the next await: read
 * through it in the synchronous stretch it was given in. (2) Nothing outside storage remembers
 * a version: a `transactionSync` that rolls back leaves nothing pointing at a version that was
 * not stored, and a version no pending record reaches is `sweep`'s to remove. An id held
 * past an await (a kept view of a copy carries its record: the copy's id and its base
 * versions' ids) is a question put to storage, never a claim: the holder asks `holds` before
 * each use, and reads nothing where storage answers that the copy is another.
 *
 * Its own rules with storage. It never writes, and never runs a `transactionSync` that can
 * throw, while a cursor is open: every statement's rows are taken with `toArray()` or `one()`
 * at once, small lists only, and content is read by key, one row at a time. It never asks a
 * write to return rows: a cursor of such a statement left unread fails the request. One
 * statement an `exec`. Everything is synchronous, so every method may run inside the caller's
 * `transactionSync` and inside a fold's reducer. One store serves every document of its
 * storage, each under its own `doc` key.
 */
export class DocStore {
  readonly #storage: DocStoreStorage;
  readonly #format: string;
  readonly #made: string;
  readonly #sizes: RunSizes;

  /**
   * Where the tables were made under another `format`, or were never made, removes them with
   * every row they hold and makes them again as this code defines them, in one transaction:
   * a format's tables have its columns. Nothing is compared or removed for `made`: a row
   * derived under another digest is not read, and goes with its document's next sweep.
   * @param storage Pass `ctx.storage`.
   * @param format For tests. Defaults to `DOC_STORE_FORMAT`.
   * @param made The digest of the code that derives results and renderings. For tests.
   * Defaults to `DOC_DERIVED`.
   * @param sizes The sizes a tab's runs are cut to. For tests. Defaults to `RUN_SIZES`.
   */
  constructor(
    storage: DocStoreStorage, format: string = DOC_STORE_FORMAT, made: string = DOC_DERIVED,
    sizes: RunSizes = RUN_SIZES,
  ) {
    this.#storage = storage;
    this.#format = format;
    this.#made = made;
    this.#sizes = sizes;
    this.#rows(FORMAT_TABLE);
    let stored = this.#rows<{ format: string }>("SELECT format FROM doc_format WHERE id = 0")[0];
    // The tables stand as they were made with the format's row.
    if (stored?.format === this.#format) return;
    this.transaction(() => {
      for (let table of DOCUMENT_TABLES) this.#rows(`DROP TABLE IF EXISTS ${table}`);
      for (let table of TABLES) this.#rows(table);
      this.#rows("INSERT OR REPLACE INTO doc_format (id, format) VALUES (0, ?)", this.#format);
    });
  }

  /**
   * Runs `run` as one transaction of the storage: a throw undoes every row and every KV write
   * it made, and is rethrown. Throws, undoing them too, where `run` returned a promise: a
   * callback that awaits commits only what it wrote before its first await.
   */
  transaction<T>(run: () => T): T {
    return this.#storage.transactionSync(() => {
      let value = run();
      requireSynchronous(value);
      return value;
    });
  }

  // One statement, its rows taken at once, so that no cursor is open when the next statement
  // runs. For small rows only: `toArray()` lands every row it returns on the heap.
  #rows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    let cursor = this.#storage.sql.exec<T>(query, ...bindings);
    let rows = cursor.toArray();
    docStoreCost.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  // The one way `doc_run.json`, `doc_md.md` and `doc_result.result` are read: `found` asks for
  // the row with the same WHERE and no content (or with the small column the caller wants beside
  // it), and `content` then reads the one large column. `one()` throws for a missing row with an
  // error that cannot be told from a fault of storage, and `toArray()` is kept off content rows,
  // which it lands on the heap whole (a list of several runs would hold them all at once). Both
  // statements run with nothing awaited between them, so the row the first found is the row the
  // second reads.
  #content<Small extends Record<string, SqlStorageValue>>(
    found: string, content: string, ...key: unknown[]
  ): { small: Small; text: string } | undefined {
    let small = this.#rows<Small>(found, ...key)[0];
    if (small === undefined) return undefined;
    let row = this.#storage.sql.exec<Record<string, string>>(content, ...key).one();
    return { small, text: Object.values(row)[0] };
  }

  // Drops the copy a version that cannot be read back belongs to, so the next read fetches.
  #unreadable(doc: string): never {
    this.drop(doc);
    throw new Error(DOC_COPY_UNREADABLE);
  }

  // The runs `version` lists, in order. An empty list is unreadable, never an empty tab: a
  // version that was swept lists no run, and a handle kept past its stretch reads what it named
  // or fails.
  #listed(version: DocVersion): RunRow[] {
    let runs = this.#rows<RunRow>(RUNS, version.id);
    return runs.length > 0 ? runs : this.#unreadable(version.doc);
  }

  // Stores `rendered`, ONE RUN's rendering, under `key`, that run's key in `doc`, where this
  // digest has not: a row another digest made is written over in place, and with `over` so is a
  // row this digest made (one that does not read back). `what` names the run for a row too large
  // and `first` is the run's first index. The summary is made of the Markdown as rendered, not
  // as stored. The parameter's type keeps a tab's rendering out: no row holds a tab's Markdown.
  #putMarkdown(
    doc: string, key: KeyRow, what: string, first: number, rendered: RenderedRun, over = false,
  ): void {
    markdownInHand(rendered.markdown);
    let at = [key.run, key.context, key.carry];
    let stored =
      this.#rows<{ made: string }>(`SELECT made ${MARKDOWN_KEY} ${IN_DOC}`, ...at, doc)[0];
    if (stored?.made === this.#made && !over) return;
    let summary = JSON.stringify(keptSummary(rendered, first));
    let markdown = markdownAsStored(rendered.markdown);
    requireRow(what, ...at, this.#made, summary, markdown);
    if (stored) {
      this.#rows(
        `UPDATE doc_md SET made = ?4, summary = ?5, md = ?6
         WHERE run = ?1 AND context = ?2 AND carry = ?3 AND doc = ?7`,
        ...at, this.#made, summary, markdown, doc,
      );
    } else {
      this.#rows(
        "INSERT INTO doc_md (run, context, carry, made, summary, md, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ...at, this.#made, summary, markdown, doc,
      );
    }
  }

  // Stores content of `doc` under its name where the document does not hold it: asked for by
  // key first, so a string of megabytes is not bound to a statement for a row that exists.
  // `what` names it for a row too large.
  #putContent(doc: string, what: string, id: string, json: string): void {
    requireRow(what, id, json);
    if (this.#rows(RUN_FOUND, id, doc).length > 0) return;
    this.#rows("INSERT INTO doc_run (id, json, doc) VALUES (?, ?, ?)", id, json, doc);
  }

  // Keys ONE run from its rendering: the context key and the carry key its rendering is stored
  // under, the rendering stored there where this digest has not, and `state` moved past the
  // run. Answers the run's entry in its version's list. It reads nothing of a later run, and
  // of the tab only what the run's rendering read.
  #keyRun(
    tabId: string, run: Omit<RunInHand, "elements">, context: RenderContext, state: Keying,
    rendered: RenderedRun,
  ): RunRow {
    // The key is of the carry before the run: taken first, and the pass moved after.
    let entry = listEntry(run.id, run.size, rendered.summary, context, state.carry);
    this.#putMarkdown(state.doc, entry, runNamed(tabId, run.holds), state.first, rendered);
    passed(state, rendered.summary, run.size);
    return entry;
  }

  // THE KEYING WALK of a tab in hand, called once a run, in order: renders the run from its
  // elements with the carry so far and keys it (`#keyRun`). It reads NOTHING OF A LATER RUN and
  // nothing of the tab but the run's elements and the tab's context, and needs no count of the
  // runs and no place counted from the end: a run's key needs its elements and the state so
  // far. A tab in hand is keyed after its id is known (`putTab`: a version found keyed is not
  // rendered); a fetched tab is keyed in the cut's pass, as each run is cut (`readTab`), and
  // its list is decided at its end (`#putVersion`).
  // What the renderer throws is a fault of the tab in hand, and is marked as one: every other
  // throw of the caller's transaction is a fault of storage.
  #keyInHand(named: Named, run: RunInHand, state: Keying): RunRow {
    let rendered = renderedInHand(run.elements, named, state.carry);
    return this.#keyRun(named.tabId, run, named, state, rendered);
  }

  // ONE PAGE of the list of version `id` of `doc`: its runs from place `from`, RUN_LIST_BATCH at
  // most, by one finished statement (so no cursor is open across a write); a page that comes
  // short is the list's last. `summaries` chooses what `summary` holds of each run:
  // - `"run"`: the renderer's summary of the run, from the rendering stored for it under the
  //   store's digest (what `summaryOf` reads);
  // - `"whole"`: that rendering's whole stored summary (what `storedSummary` reads);
  // - `"none"`: NULL ON EVERY ROW, WHICH SAYS NOTHING OF WHAT IS STORED: the page with no
  //   join, for a walk that never reads `summary`.
  // `limit` is the most runs it asks for, where a walk ends before the page does.
  #page(
    { doc, id }: VersionKey, from: number, summaries: "none" | "run" | "whole" = "run",
    limit = RUN_LIST_BATCH,
  ): ListedRun[] {
    return summaries === "none"
      ? this.#rows<ListedRun>(RUNS_FROM, id, from, limit)
      : this.#rows<ListedRun>(
        summaries === "run" ? RUNS_KEYED_FROM : RUNS_SUMMARISED, id, this.#made, from, limit, doc);
  }

  // The list of `version` from place `from`, through ONE READER: a page at a time (`#page`), the
  // next page read when the one in hand is spent and never before, and no statement once a
  // page came short. NO PLACE IS READ TWICE, whoever takes the runs. The reader holds the page
  // in hand and where it stands in it, and nothing of a page before: one page of rows,
  // whatever the list's length and whatever its summaries. A reader that ends at place `to`
  // answers no run at or past it, and its last page asks for no row past it. `most` is the
  // most runs its first page asks for: each page after it asks for four times as many, up to
  // a full page.
  #pages(
    version: VersionKey, from = 0, summaries: "none" | "run" | "whole" = "run", to = Infinity,
    most = RUN_LIST_BATCH,
  ): ListReader {
    let page: ListedRun[] = [];
    let at = 0, ended = from >= to;
    return () => {
      if (at === page.length) {
        if (ended) return undefined;
        let limit = Math.min(most, to - from);
        most = Math.min(RUN_LIST_BATCH, 4 * most);
        page = this.#page(version, from, summaries, limit);
        from += page.length;
        ended = page.length < limit || from >= to;
        at = 0;
        if (page.length === 0) return undefined;
      }
      return page[at++];
    };
  }

  // `like`'s list for the keying walk (`#pages`, each run with the renderer's summary of it).
  // `undefined` where `like` is not keyed under the store's digest: asked of `derived`, what
  // `like`'s record says code derived of it.
  #listFrom(like: DocVersion, derived: string): ListReader | undefined {
    return derivedUnder(derived, this.#made)?.keyed ? this.#pages(like) : undefined;
  }

  // What `#keyBeside` reads of `like` FROM THE RUN `first` ON: `first`, which the reader has
  // answered already, and then every run the reader has left. `undefined` where there is no
  // `first`, or a run with no summary that reads back (the runs after it are then not read).
  // Places are counted from `first`. It holds, of each of those runs, its carry key and the
  // renderer's summary of it, and each id's places, its context key and its carry keys;
  // summaries of the same text are ONE object (a tab of thousands of tables lists few
  // distinct ones): the map that finds them is a local of this call and is gone when it
  // returns. Nothing of `like` is decoded, rendered or written, and no fault of it thrown: the
  // keying never renders `like`'s missing run (`#keyed`, `#renderAt`, `#rekey`) nor reads its
  // list or its tab another way (`#listed`, `tab`), and so never finds it unreadable. A fetch
  // stores its tab whatever state the copy it replaces is in, where a render from storage
  // would fail the fetch on a fault of the copy it replaces, at every retry.
  #beside(next: ListReader, first: ListedRun | undefined): Beside | undefined {
    if (!first) return undefined;
    let summaries = new Map<string, RunSummary>();
    let theirs: { carry: string; summary: RunSummary }[] = [];
    let known = new Map<string, RunBeside>();
    for (let listed: ListedRun | undefined = first; listed !== undefined; listed = next()) {
      let { run, context, carry, summary: text } = listed;
      if (text === null) return undefined;
      let summary = summaries.get(text);
      if (!summary) {
        summary = summaryOf(listed);
        if (!summary) return undefined;
        summaries.set(text, summary);
      }
      let place = theirs.length;
      theirs.push({ carry, summary });
      let held = known.get(run);
      if (held) {
        held.places.push(place);
        held.carries.add(carry);
      } else {
        known.set(run, { places: [place], passed: 0, context, carries: new Set([carry]), summary });
      }
    }
    return { theirs, known };
  }

  // THE KEYING WALK of a tab in hand BESIDE a stored version it probably shares runs with:
  // answers what is called once a run, in order, in place of `#keyInHand`. FORWARD ONLY, by one
  // rule; it reads nothing of a later run, no count of the runs and no place counted from the
  // end. It carries this version's carry (`state`), the other version's carry at the place the
  // walk has reached in its list (`beside`, `next`), and whether the two carries are known to
  // be the same (`level`). The other version's carry is held as what differs from this one's
  // (`besideOf`), which `state` moves through from here on: no carry is copied, a move costs
  // the lists the run counts in, and whether the two are the same again reads no number.
  // A run is KNOWN where the other version lists its id, at any place, under the context key
  // the run has in this tab: asked of every run, whether or not the two versions have one
  // context, since a list can be defined otherwise under the same id. The summary stored with
  // a rendering of a known run is the run's summary at every place and under every carry, so
  // it gives the run's key and the carry after it with no element read.
  // The walk is IN STEP at a run the other version lists at or after `next`: at the nearest
  // such place, the runs before it passed and the other carry moved over their summaries.
  // - A run that is not known is rendered from the elements in hand.
  // - A known run, in step, with the carries the same, keeps the keys the other version lists
  //   at that place: nothing is keyed, read or rendered.
  // - Any other known run is re-keyed: its key is worked out of the carry, and it is rendered
  //   from hand only where no rendering is stored under that key (asked with no statement where
  //   the key is one the other version lists for the run). The carries are compared after it,
  //   so the run directly after a rendered or a passed one is always re-keyed, and the walk
  //   settles where the carry is the other version's again.
  // WHAT A REPEATED ID COSTS: an id the other version lists more than once (tables that are the
  // same, stretches of the same empty paragraphs) can put the walk out of step for the rest of
  // the tab: with one more such table put in, each later table is found one place ahead and
  // each stretch between is then behind `next`. Nothing more is rendered: the later runs are
  // re-keyed, a small computation each, with no statement where the key is a listed one.
  #keyBeside(named: Named, state: Keying, { theirs, known }: Beside): (run: RunInHand) => RunRow {
    // The other version's carry where the walk takes it up is this version's: the walk is
    // taken up at the other's first run, or after a stretch in which the two had the same runs.
    let beside = besideOf(state), next = 0, level = true;
    return run => {
      let held = known.get(run.id);
      let at: number | undefined;
      if (held) {
        while (held.passed < held.places.length && held.places[held.passed] < next) held.passed++;
        at = held.places[held.passed];
      }
      if (at !== undefined) {
        // The runs the other version holds before this one, which this version does not.
        for (; next < at; next++) {
          beside.advanceTheirs(theirs[next].summary);
          level = false;
        }
        next = at + 1;
      }
      if (!held || listedContext(held.summary, named) !== held.context) {
        if (at !== undefined) beside.advanceTheirs(theirs[at].summary);
        level = false;
        return this.#keyInHand(named, run, state);
      }
      if (at !== undefined && level) {
        passed(state, held.summary, run.size);
        beside.advanceTheirs(held.summary);
        return { run: run.id, context: held.context, carry: theirs[at].carry, size: run.size };
      }
      let carry = runCarryKey(held.summary, state.carry);
      docStoreCost.runsKeyed++;
      let entry: RunRow;
      if (held.carries.has(carry) || this.#rows(
        `SELECT 1 AS found ${MARKDOWN_KEY} AND made = ? ${IN_DOC}`,
        run.id, held.context, carry, this.#made, state.doc,
      ).length > 0) {
        entry = { run: run.id, context: held.context, carry, size: run.size };
        passed(state, held.summary, run.size);
      } else {
        entry = this.#keyInHand(named, run, state);
      }
      if (at !== undefined) beside.advanceTheirs(held.summary);
      level = at !== undefined && beside.same();
      return entry;
    };
  }

  // THE KEYING of one tab of a fetched document: answers what is called once a run, in order,
  // as each run is cut, and gives the run's entry in its version's list. `contextKey` names
  // the tab's context and `like` is the base version the stored copy lists for the tab.
  // Before the first run it reads one small row (whether `like` is keyed under the store's
  // digest, and its context's name) and nothing of `like`'s list.
  // - WHILE THE TAB IS IN STEP WITH `like` (the two have one context, and each run so far is
  //   `like`'s run at the same place, with a summary that reads back) the run keeps `like`'s
  //   keys at that place and the carry is moved over the run's summary: nothing is rendered
  //   or keyed, and of `like` one page of its list is in hand (`#listFrom`). The summary
  //   parsed is let go with the call.
  // - AT THE FIRST RUN THAT DIFFERS (another run, `like`'s list ended, or a tab whose context
  //   is not `like`'s, which differs at its first run) the walk beside `like` is taken up
  //   from that place (`#beside`, `#keyBeside`): built from the run the reader answered for
  //   the place and the runs it has left, so `like`'s list is read once wherever the tab
  //   first differs, and held from that place on only. A run `like` lists only before that
  //   place is not known to the walk and is rendered from hand: its entry is the same, and
  //   its rendering is found stored.
  // - Where `like` is not keyed under the store's digest, or the run at a place in step has no
  //   summary that reads back, the runs from there on are rendered from hand (`#keyInHand`),
  //   with the carry the stretch in step moved.
  // The walk is chosen once a tab.
  #keying(
    named: Named, contextKey: string, state: Keying, like: DocVersion | undefined,
  ): (run: RunInHand) => RunRow {
    let inHand = (run: RunInHand) => this.#keyInHand(named, run, state);
    let record = like &&
      this.#rows<{ context: string; derived: string }>(VERSION_KEYS, like.doc, like.id)[0];
    let next = like && record && this.#listFrom(like, record.derived);
    if (!record || !next) return inHand;
    let inStep = record.context === contextKey;
    let walk: ((run: RunInHand) => RunRow) | undefined;
    return run => {
      if (walk) return walk(run);
      let theirs = next();
      if (inStep && theirs?.run === run.id) {
        let summary = summaryOf(theirs);
        if (summary) {
          passed(state, summary, run.size);
          return { run: run.id, context: theirs.context, carry: theirs.carry, size: run.size };
        }
        // `like`'s rendering of the run is gone: its keys are not taken past this place.
        walk = inHand;
      } else {
        let beside = this.#beside(next, theirs);
        walk = beside ? this.#keyBeside(named, state, beside) : inHand;
      }
      return walk(run);
    };
  }

  // Writes the run list of version `id` of `doc` as `add` is handed each run's entry in order: a
  // batch of `RUN_LIST_BATCH` runs a statement, each written when it is full and the last by
  // `end`. `over` says a list is stored for `id`, which this one is written over in place.
  // BEFORE THE FIRST ENTRY IS WRITTEN, while the list as it was is whole, ONE statement removes
  // the renderings another digest made under the keys that list holds (`DROP_OTHERS_OF`): none
  // is then left under a key the list drops. A rendering under a key the list keeps is written
  // again under the store's digest: over the other digest's row where its run was keyed before
  // that statement ran (the runs of the first batch), as a row of its own after it. Every
  // statement that writes the list goes through `write`, which runs that removal first. One
  // batch of the entries it writes is in hand at a time, and nothing of the list as it was. THE
  // ONE WRITER OF A LIST: an entry in hand by `add`, and a stretch of another version's list by
  // `copy`.
  #listWriter(doc: string, id: string, over: boolean) {
    let batch: (string | number)[][] = [];
    let written = 0;
    let write = (statement: string, ...bindings: unknown[]) => {
      if (over) this.#rows(DROP_OTHERS_OF, id, this.#made, doc);
      over = false;
      this.#rows(statement, ...bindings);
    };
    let flush = () => {
      if (batch.length === 0) return;
      write(PUT_RUNS, id, JSON.stringify(batch), written);
      written += batch.length;
      batch = [];
    };
    return {
      add: (entry: RunRow) => {
        batch.push([entry.run, entry.context, entry.carry, entry.size]);
        if (batch.length >= RUN_LIST_BATCH) flush();
      },
      // The runs `of` lists at places [from, to), as it lists them, at the places written so
      // far: one statement inside storage, after the batch in hand is written. No entry of
      // them enters the isolate. A copy of no run runs no statement.
      copy: (of: string, from: number, to: number) => {
        if (to <= from) return;
        flush();
        write(COPY_RUNS, id, of, from, to, written - from);
        written += to - from;
      },
      end: flush,
    };
  }

  /**
   * The id `putTab(doc, tab, ...)` would give the version, with nothing read or written: the
   * tab is cut and each run named, one run's JSON in hand at a time. For `DocPending.roots`.
   */
  versionId(doc: string, tab: GoogleDocsTab): string {
    return tabParts(doc, tab, this.#sizes).id;
  }

  /**
   * Stores `tab` as a version of document `doc` and answers its handle. The tab is cut into
   * runs (`cutRuns`); each run, the tab's context, the version's record and its run list are
   * written only where they are not stored (each asked for by its key first, so content
   * already stored is not handed to storage again). Where the version is not stored, or was
   * last keyed under another digest, EVERY RUN'S KEY IS WORKED OUT HERE and the list written
   * with it, so that a read of the version renders nothing. A version keyed under the store's
   * digest is answered with nothing rendered.
   * Each run is rendered from the elements in hand, in order, with the carry of the one
   * before, and its Markdown and summary stored where they are not (`#keyInHand`). Keying a
   * run needs its elements and the carry so far, and nothing of a later run.
   * WHO STORES WHICH WAY: a tab in hand that nothing is stored beside is stored here (the
   * blank tab of a pending add). A fetched tab is stored by `keep`, keyed beside the stored
   * copy's. The version an edit gives is stored by `putSlice`, beside the version it was made
   * in.
   * WHAT THE RENDERER THROWS on a run of the tab in hand is thrown as a `DocRunRenderError`:
   * a fault of the tab, not of storage. Nothing of the version is then stored (the caller's
   * transaction is the one that fails).
   * The handle carries the identity `tab` states and `writeMarkers`; neither is stored with
   * the version, nor part of its id.
   * @param tab A pruned tab (`pruneTab`), or one the model returned for a pruned tab, which
   * is stored as the model's own (`exact`) and taken at that word for its lists as for its
   * indexes: it names no list of the model's form it does not define, as no tab the model
   * returned for a followed tab does.
   * @throws `DocRowTooLargeError` for an element, a context or a run's Markdown too large for a
   * row; `DocRunRenderError` where the renderer throws on a run of `tab`.
   */
  putTab(doc: string, tab: GoogleDocsTab, writeMarkers: readonly DocWriteMarkerCopy[]): DocVersion {
    return this.transaction(() => {
      let { runs, context, contextKey, meta, first, id } = tabParts(doc, tab, this.#sizes,
        (run, runKey) => this.#putContent(doc, runNamed(tab.tabId, run.holds), runKey, run.json));
      this.#putContent(doc, listsNamed(meta.tabId), contextKey, context);
      runsOfTab.set(tab, runs.length);
      let stored = this.#rows<{ derived: string }>(VERSION_DERIVED, doc, id)[0];
      let derived = stored && derivedUnder(stored.derived, this.#made);
      // A tab the model made is followed by definition: it is never walked. A tab as Google
      // sent it is walked where this digest has not said it of the version.
      let unindexed = derived?.unindexed ??
        (!meta.exact && (!hasModelIndexes(tab) || !hasModelFootnotes(tab)));
      if (!derived?.keyed) {
        // The list another digest keyed is written over: its runs are these, its keys may not be.
        let list = this.#listWriter(doc, id, stored !== undefined);
        let state = keyingFrom(doc, first);
        for (let run of runs) list.add(this.#keyInHand(tab, run, state));
        list.end();
      }
      if (!derived?.keyed || (!meta.exact && derived.unindexed === undefined)) {
        this.#putRecord(doc, id, stored !== undefined, contextKey, meta, unindexed);
      }
      return handle(doc, id, meta, { ...tab, writeMarkers: markersOf(writeMarkers) });
    });
  }

  // Writes the row of version `id` of `doc`, keyed under the store's digest: the row where
  // none is `stored`, and otherwise what its row says code derived of the version.
  #putRecord(
    doc: string, id: string, stored: boolean, contextKey: string, meta: VersionMeta,
    unindexed: boolean,
  ): void {
    let text = JSON.stringify({ made: this.#made, unindexed, keyed: true });
    if (stored) this.#rows(PUT_DERIVED, doc, id, text);
    else {
      this.#rows(
        "INSERT INTO doc_version (doc, id, context, derived, meta) VALUES (?, ?, ?, ?, ?)",
        doc, id, contextKey, text, JSON.stringify(meta),
      );
    }
  }

  // Writes what a version holds beside its runs' rows, once its id is known: the context where
  // it is not stored, and then, AS `putTab` DOES, the list where the version is not keyed under
  // this digest (in place of the list another digest keyed) and the version's row or its
  // `derived`. A version found keyed under this digest has nothing written: `entries` is not
  // read.
  #putVersion(
    doc: string, context: { json: string; key: string },
    end: { meta: VersionMeta; id: string; unindexed: boolean }, entries: readonly RunRow[],
  ): void {
    let { meta, id } = end;
    this.#putContent(doc, listsNamed(meta.tabId), context.key, context.json);
    let stored = this.#rows<{ derived: string }>(VERSION_DERIVED, doc, id)[0];
    let derived = stored && derivedUnder(stored.derived, this.#made);
    if (!derived?.keyed) {
      // The list another digest keyed is written over: its runs are these, its keys may not be.
      let list = this.#listWriter(doc, id, stored !== undefined);
      for (let entry of entries) list.add(entry);
      list.end();
    }
    if (!derived?.keyed || derived.unindexed === undefined) {
      this.#putRecord(
        doc, id, stored !== undefined, context.key, meta, derived?.unindexed ?? end.unindexed);
    }
  }

  /**
   * Version `id` of `doc`, or `undefined` where none is stored. Reads one small row. The
   * stored version holds neither the tab's name and place nor its write markers: the handle
   * is given those of `as`, which the caller reads of the copy's record (a base version) or
   * of the version an edit was made in (the version it gives).
   */
  version(doc: string, id: string, as: HandleOf): DocVersion | undefined {
    let row = this.#rows<VersionRow>(VERSION, doc, id)[0];
    let meta = row && versionMeta(row.meta);
    // A handle is never given another tab's name.
    return meta && meta.tabId === as.tabId ? handle(doc, id, meta, as) : undefined;
  }

  /**
   * Whether every row a decode of `version` reads is stored: its record, a run list that is
   * not empty, each run it lists and its context. Reads no content, and asks of the runs with
   * ONE statement whatever their number (the list joined to `doc_run` by its key's index): for
   * a caller that must know before it starts that a replay will not fail on the copy's base.
   */
  has(version: DocVersion): boolean {
    let row = this.#rows<VersionRow>(VERSION, version.doc, version.id)[0];
    if (row === undefined) return false;
    let [{ listed, stored }] =
      this.#rows<{ listed: number; stored: number }>(RUNS_STORED, version.id, version.doc);
    return listed > 0 && listed === stored &&
      this.#rows(RUN_FOUND, row.context, version.doc).length > 0;
  }

  /**
   * Whether the model cannot follow `version`'s tab: `hasModelIndexes` or `hasModelFootnotes`
   * fails for it. Such a tab is read as it is and takes no edit. `false`, with nothing read,
   * for a version the model made (`exact`). Otherwise read from the version's record where it
   * was worked out under the store's digest; where it was not, the version's runs are decoded
   * one at a time, in order, and handed to `modelFollowing` as they pass, and the record says
   * so from then on: one page of the list and one run in hand, and of the tab's lists the
   * ids of the model's own form its context defines (`MODEL_LISTS_OF`), which is all the
   * question reads of them. A fetch works it out as the tab's elements pass (`keep`), and
   * `putTab` of the tab it has in hand, writing `false` for a tab the model made without
   * walking it; so a version stored under this digest is never decoded for it.
   * @throws As `tab` does, where the version cannot be read back.
   */
  unindexed(version: DocVersion): boolean {
    if (version.exact) return false;
    let row = this.#rows<{ derived: string }>(VERSION_DERIVED, version.doc, version.id)[0];
    let derived = row && derivedUnder(row.derived, this.#made);
    if (derived?.unindexed !== undefined) return derived.unindexed;
    let context = this.#rows<VersionRow>(VERSION, version.doc, version.id)[0]?.context;
    let [total] = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, version.id);
    if (context === undefined || total.runs === 0) return this.#unreadable(version.doc);
    let made =
      this.#rows<{ id: string | null }>(MODEL_LISTS_OF, context, MODEL_LIST_ID, version.doc);
    // No row: the context is missing or is not one.
    if (made.length === 0) return this.#unreadable(version.doc);
    let lists: Record<string, unknown> = {};
    for (let { id } of made) if (id !== null) lists[id] = {};
    let following = modelFollowing(lists);
    // Where each run stands: sums of the walk's own, which reads no summary and owns no
    // carry. A stored footnote number counts from the references before its run.
    let first = version.bodyEndIndex - total.size, footnotes = 0;
    let next = this.#pages(version, 0, "none");
    for (let listed = next(); listed !== undefined; listed = next()) {
      let decoded =
        this.#whole(version, this.#decoded(version, listed.run, { first, footnotes }), () => total.runs);
      for (let element of decoded.elements) following.take(element);
      first += listed.size;
      footnotes += decoded.footnotes;
    }
    let unindexed = !following.followed();
    // What this digest said of the version's keys stays; what another said is not this code's.
    this.#rows(
      PUT_DERIVED, version.doc, version.id,
      JSON.stringify({ made: this.#made, unindexed, ...(derived?.keyed ? { keyed: true } : {}) }),
    );
    return unindexed;
  }

  // One stored run of `version` decoded at its place: its elements with the indexes and the
  // footnote numbers they have in the tab. `exact` says whether an opening section break is
  // given its start (`decodeRun`): the version's own word, or `true` for a piece the model is
  // handed, which holds every index. Counts a run decoded; its JSON is in hand until the
  // parse returns. `undefined` where the row is missing or is not a stored run.
  #decoded(
    version: DocVersion, run: string, at: { readonly first: number; readonly footnotes: number },
    exact = version.exact,
  ): { elements: StructuralElement[]; footnotes: number } | undefined {
    let stored = this.#content(RUN_FOUND, RUN_JSON, run, version.doc);
    if (stored === undefined) return undefined;
    runInHand(stored.text);
    let decoded = decodeRun(stored.text, { ...at, exact });
    docStoreCost.runsDecoded++;
    return decoded;
  }

  // What `#decoded` made of a run of `version`, held to what a stored run is: the copy is
  // dropped where its row is missing, or where it holds no element and is not the only one of
  // the `runs` the version lists (an empty body is one run of none).
  #whole<Run extends { elements: StructuralElement[] }>(
    version: DocVersion, decoded: Run | undefined, runs: () => number,
  ): Run {
    return decoded && (decoded.elements.length > 0 || runs() === 1)
      ? decoded : this.#unreadable(version.doc);
  }

  // `StoredRun.elements` of the run of `version` stored as `run`. The runs are counted only
  // for a run of none.
  #elements(version: DocVersion, run: string): StoredRun["elements"] {
    return (first, footnotes = 0) => this.#whole(
      version, this.#decoded(version, run, { first, footnotes }),
      () => this.#rows<{ runs: number }>(RUNS_TOTAL, version.id)[0].runs).elements;
  }

  /**
   * The tab of `version`, decoded from its stored runs, in order, and its context, for one
   * synchronous stretch: one run's JSON is in hand at a time, the decoded tab whole. It is
   * the tab whole, for a caller that wants one: nothing that reads or edits a document calls
   * it. A
   * version the model made (`exact`) is known to the model again (`markModelIndexed`). Counts
   * a run decoded for each. Content is read by its key, one row a statement (`one()` of a row
   * the run list or an existence check said is there): no content row is taken with
   * `toArray()`.
   * @throws An `Error` whose message is `DOC_COPY_UNREADABLE` where a row is missing or is
   * not what was stored, where the version lists no run (a version that was swept lists none:
   * it is unreadable, never an empty tab), or where a run of no element is not the version's
   * only run (an empty body is one run of none); the document's copy is dropped first, so the
   * next read fetches. `markdown` and `summary` throw the same for the same.
   */
  tab(version: DocVersion): GoogleDocsTab {
    let runs = this.#listed(version);
    let row = this.#rows<VersionRow>(VERSION, version.doc, version.id)[0];
    if (row === undefined) return this.#unreadable(version.doc);
    let content: GoogleDocsTab["body"]["content"] = [];
    let first = firstIndex(version, runs);
    let footnotes = 0;
    for (let { run, size } of runs) {
      let decoded =
        this.#whole(version, this.#decoded(version, run, { first, footnotes }), () => runs.length);
      for (let element of decoded.elements) content.push(element);
      first += size;
      footnotes += decoded.footnotes;
    }
    let stored = this.#content(RUN_FOUND, RUN_JSON, row.context, version.doc);
    let context = stored && parsed(stored.text);
    if (!isRecord(context) || !isRecord(context.lists)) return this.#unreadable(version.doc);
    // The key order is the pruning's, so the tab reads as the tab that was stored.
    let tab: GoogleDocsTab = {
      ...tabIdentity(version),
      body: { content },
      lists: context.lists as GoogleDocsTab["lists"],
      namedRanges: {},
      ...(context.namedStyles === undefined
        ? {}
        : { namedStyles: context.namedStyles as GoogleDocsTab["namedStyles"] }),
    };
    if (version.exact) markModelIndexed(tab);
    runsOfTab.set(tab, runs.length);
    return tab;
  }

  /**
   * The elements of each run of `version`, in order, a run at a time: each decoded at its
   * place, with the indexes and footnote numbers it has in the tab (`decodeRun`), and let go
   * when the next is asked for. For a reader of the tab's own text, which no rendering
   * holds. The list is read a page at a time and content by key, one row a run: ONE RUN'S
   * JSON AND ITS ELEMENTS ARE IN HAND, and of the runs passed a running first index and a
   * footnote count. A caller holds as much only if it lets go of each run before it asks
   * for the next, which a `for...of` does not. Counts a run decoded for each. Renders
   * nothing, keys nothing and writes nothing; storage bills four rows a run, the list read
   * for its totals and then by its pages, and each run's row found and then read. Valid
   * until the next await, as the handle is: iterate it in the stretch it was made in.
   * @throws As `tab` does where the version cannot be read back. The copy is dropped first,
   * and a caller that reads inside a transaction of its own drops it after that fails, as
   * for any read of storage.
   */
  *runs(version: DocVersion): Generator<readonly StructuralElement[]> {
    let [total] = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, version.id);
    if (total.runs === 0) return this.#unreadable(version.doc);
    // Where each run stands: sums of the walk's own, which reads no summary.
    let at = { first: version.bodyEndIndex - total.size, footnotes: 0 };
    let next = this.#pages(version, 0, "none");
    // The next run's elements, with `at` moved past it. What it decoded is its own, gone when
    // it returns: between two runs the generator holds the page, the place and two numbers.
    let step = (listed: ListedRun): readonly StructuralElement[] => {
      let decoded = this.#whole(version, this.#decoded(version, listed.run, at), () => total.runs);
      at.first += listed.size;
      at.footnotes += decoded.footnotes;
      return decoded.elements;
    };
    for (let listed = next(); listed !== undefined; listed = next()) yield step(listed);
  }

  /**
   * The definitions of the lists `ids` as `version`'s tab holds them, by id: a list the tab
   * does not define is absent. For a read that names the lists it asks about. THE LISTS ASKED
   * FOR ALONE REACH THE ISOLATE (`LISTS_OF`): no run is read and none decoded, and for no id
   * nothing is read at all. Storage bills the version's row, its context's row twice (once to
   * find that it is one, `STYLES_OF`) and a row for each list the context defines.
   * @throws As `tab` does where the version or its context cannot be read back.
   */
  lists(version: DocVersion, ids: readonly string[]): GoogleDocsTab["lists"] {
    if (ids.length === 0) return {};
    let context = this.#rows<VersionRow>(VERSION, version.doc, version.id)[0]?.context;
    if (context === undefined || this.#stylesOf(version.doc, context) === null) {
      return this.#unreadable(version.doc);
    }
    let defined = this.#rows<{ id: string; definition: SqlStorageValue }>(
      LISTS_OF, context, JSON.stringify(ids), version.doc);
    // Own properties, whatever the ids.
    return Object.fromEntries(defined.map(({ id, definition }) =>
      [id, listDefined(definition) ?? this.#unreadable(version.doc)])) as GoogleDocsTab["lists"];
  }

  // The named styles of the context `doc` stores as `context` (`STYLES_OF`), as a rendering reads
  // them: `{}` where it names none, and `null` where the row is missing, is not a context
  // (its lists are not a record) or its styles are not a record.
  #stylesOf(doc: string, context: string): Pick<RenderContext, "namedStyles"> | null {
    let row =
      this.#rows<{ lists: string | null; styles: string | null }>(STYLES_OF, context, doc)[0];
    let namedStyles = row?.styles == null ? undefined : parsed(row.styles);
    if (row?.lists !== "object" || (row.styles !== null && !isRecord(namedStyles))) return null;
    return namedStyles === undefined ? {} : { namedStyles: namedStyles as GoogleDocsTab["namedStyles"] };
  }

  // What the stored runs of ONE WALK of a version's list are rendered with (`RunContexts`).
  // `context`: the id of the context row of `doc` the runs are rendered with. `list`: the id of
  // the version of `doc` whose list the places are counted in. Holds the context's named styles,
  // read once, at the first run asked for; and FOR THE PAGE THAT HOLDS THE PLACE (places
  // [k * RUN_LIST_BATCH, (k + 1) * RUN_LIST_BATCH) of the list) the definitions of the lists its
  // runs name, as text by id, loaded by ONE statement (`LISTS_NAMED`) at the first run of that
  // page asked for and replaced at the next page's. A walk that renders no run issues no
  // statement. Nothing is held for every run. Of the lists, what is held is the definitions the
  // page in hand names: AT MOST THE CONTEXT'S TEXT, a row, and all of it where the runs of one
  // page name every list of the tab (a tab of one page can); a page's share on a tab of many
  // pages.
  #contexts(doc: string, context: string, list: string): RunContexts {
    // `null` where the row is not a context: asked of every run, whether or not it names a list.
    let styles: Pick<RenderContext, "namedStyles"> | null | undefined;
    let page = -1;
    let definitions = new Map<string, SqlStorageValue>();
    return (place, elements) => {
      styles ??= this.#stylesOf(doc, context);
      if (styles === null) return undefined;
      let at = Math.floor(place / RUN_LIST_BATCH);
      if (at !== page) {
        page = at;
        // The page before is let go before this one is read: one page's definitions in hand.
        definitions = new Map();
        for (let { id, definition } of this.#rows<{ id: string; definition: SqlStorageValue }>(
          LISTS_NAMED, context, list, at * RUN_LIST_BATCH, (at + 1) * RUN_LIST_BATCH, doc,
        )) {
          definitions.set(id, definition);
        }
      }
      let lists: [string, unknown][] = [];
      for (let listId of namedListIds(elements)) {
        // A list a run names and the tab does not define is absent.
        if (!definitions.has(listId)) continue;
        let defined = listDefined(definitions.get(listId));
        if (!defined) return undefined;
        lists.push([listId, defined]);
      }
      // Own properties, whatever the ids.
      return { lists: Object.fromEntries(lists) as GoogleDocsTab["lists"], ...styles };
    };
  }

  // The carry and the first index at `place` of `version`'s list, from the stored summaries
  // of the runs before it: the version's totals (`RUNS_TOTAL`) for the tab's first index,
  // then the pages that hold a place before `place` read again from the list's start
  // (`#page`, whole summaries: one statement for each RUN_LIST_BATCH places begun, none for
  // place 0), one in hand at a time beside the caller's own, a carry of the walk's own
  // (`keyingFrom`) moved over each summary (`passed`). FOR THE READ THAT MUST RENDER A RUN
  // ALONE, once a walk: the one pass of a read that moves a carry. `undefined` where a
  // summary before `place` does not read back (the caller's walk read each of them in the
  // same stretch, so the list is then not this code's). `before`, where given, is added the
  // Markdown length and the tables of each of those runs, as their summaries say them; a
  // caller that has asked the version's totals in the same stretch hands them as `total`.
  #stateAt(
    version: DocVersion, place: number, before?: { markdown: number; tables: number },
    total = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, version.id)[0],
  ): Keying | undefined {
    if (total.runs === 0) return this.#unreadable(version.doc);
    let state = keyingFrom(version.doc, version.bodyEndIndex - total.size);
    for (let from = 0; from < place; from += RUN_LIST_BATCH) {
      let page = this.#page(version, from, "whole");
      for (let at = 0; at < Math.min(RUN_LIST_BATCH, place - from); at++) {
        let listed: ListedRun | undefined = page[at];
        let summary = typeof listed?.summary === "string" ? storedSummary(listed.summary) : undefined;
        if (!listed || !summary) return undefined;
        passed(state, summary.run, listed.size);
        if (before) {
          before.markdown += summary.markdownLength;
          before.tables += summary.tables.length;
        }
      }
    }
    return state;
  }

  // `version`'s runs in order for a READ, which must answer: A PAGE OF THE LIST IN HAND AT A
  // TIME (`#page`, whole summaries), each run handed to `each` with its stored summary, parsed
  // as the run is reached and let go with it.
  // WHILE EVERY RUN HAS ITS SUMMARY THE WALK CARRIES NOTHING: no carry is moved and no size
  // summed, so a read whose renderings are all stored holds a page and costs its pages,
  // whatever the tab's runs and lists. AT THE FIRST RUN THAT MUST BE RENDERED ALONE (its
  // rendering's row is missing, its summary does not read back, or the caller asks `alone` of
  // it, its own read of the row not reading back) the state it is rendered with is made
  // (`#stateAt`), and from that run on the walk moves it over each run as it passes; the run
  // is rendered by `#renderAt`, with what the walk's runs are rendered with (`#contexts`).
  // `each` answers `false` where that shows the list is not this code's, and `"done"` where
  // it needs no run after the one in hand: the walk ends there, with nothing said of the list.
  // THE RUNS WALKED are those at places `[from, to)`: the list is read from `from`, and no
  // row at or past `to` is asked for.
  // `undefined` where the version is not keyed under the store's digest (its keys are then
  // not this code's, and no rendering is looked up by them), where a run rendered alone shows
  // that its list is not what this code makes of it, or where `each` said so; a version that
  // lists no run is unreadable.
  #keyed(
    version: DocVersion,
    each: (
      run: KeyedRun, alone: () => RenderedRun | undefined, place: number,
    ) => boolean | "done",
    from = 0, to = Infinity, marked = false,
  ): true | undefined {
    let runs = this.#keyedRuns(version, from, to, marked);
    if (!runs) return undefined;
    let run = runs.next();
    // No run at the first place is a version that lists none; past it, a walk of no run.
    if (run === undefined) return from === 0 && to > 0 ? this.#unreadable(version.doc) : true;
    for (; run; run = runs.next()) {
      let more = each(run, runs.alone, runs.place);
      if (more === "done") return true;
      if (!more) return undefined;
    }
    return run === undefined ? true : undefined;
  }

  // The runs `#keyed` hands, PULLED ONE A CALL, so that two versions' lists can be read side
  // by side: forwards over the places `[from, to)`, or with `back` backwards from the run
  // before place `from` to the list's first. ONE PAGING for both: a page backwards is the
  // page's statement (`#page`) asked from as many places earlier as the page holds, 0 at the
  // least, and handed last row first. `most` is the most runs the first page asks for
  // (`#pages`). Forwards the state a run is rendered alone with is made at
  // the first such run and moved over each run as it is passed; BACKWARDS IT IS WORKED OUT
  // FOR THAT RUN ALONE (`#stateAt`, a pass of the summaries before it for each run rendered:
  // a carry only moves forward, and a run with no rendering is the rare one; where a run
  // before it has no rendering either, there is no such state, and the run is answered as
  // one that shows the list is not this code's: the caller keys the version again). It
  // holds one page of the list and the run in hand. `undefined` where the version is not
  // keyed under the store's digest.
  #keyedRuns(
    version: DocVersion, from = 0, to = Infinity, marked = false, back = false,
    most = RUN_LIST_BATCH,
  ): KeyedRuns | undefined {
    let record = this.#rows<{ derived: string }>(VERSION_DERIVED, version.doc, version.id)[0];
    if (record === undefined || !derivedUnder(record.derived, this.#made)?.keyed) return undefined;
    let state: Keying | undefined;
    let contexts: RunContexts | undefined;
    let forwards = back ? undefined : this.#pages(version, from, "whole", to, most);
    // Backwards: the page in hand holds the places from `first` on, and `left` of its rows
    // are still to hand.
    let page: ListedRun[] = [];
    let first = from, left = 0;
    let backwards = (): ListedRun | undefined => {
      while (left === 0) {
        if (first <= 0) return undefined;
        let asked = Math.min(most, first);
        most = Math.min(RUN_LIST_BATCH, 4 * most);
        first -= asked;
        page = this.#page(version, first, "whole", asked);
        left = page.length;
      }
      return page[--left];
    };
    let place = back ? from : from - 1;
    let listed: ListedRun | undefined;
    // The run in hand: rendered alone once, whoever asks, and what the state passes next.
    let rendered: RenderedRun | undefined;
    let inHand: KeyedRun | undefined;
    let ended = false;
    let alone = () => {
      if (rendered || !listed) return rendered;
      if (back) state = this.#stateAt(version, place);
      else state ??= this.#stateAt(version, place);
      if (!state) return undefined;
      if (!contexts) {
        let row = this.#rows<VersionRow>(VERSION, version.doc, version.id)[0];
        if (row === undefined) return this.#unreadable(version.doc);
        contexts = this.#contexts(version.doc, row.context, version.id);
      }
      rendered = this.#renderAt(
        version, listed, { place, first: state.first, carry: state.carry }, contexts, marked);
      return rendered;
    };
    return {
      alone,
      get place() {
        return place;
      },
      next: () => {
        if (ended) return undefined;
        if (!back && state && inHand) passed(state, inHand.summary.run, inHand.size);
        rendered = inHand = undefined;
        listed = forwards ? forwards() : backwards();
        if (listed === undefined) {
          ended = true;
          return undefined;
        }
        place = forwards ? place + 1 : first + left;
        let { run, context, carry, size } = listed;
        let summary = listed.summary === null ? undefined : storedSummary(listed.summary);
        if (summary === undefined) {
          let made = alone();
          if (made === undefined || state === undefined) return false;
          summary = keptSummary(made, state.first);
        }
        inHand = { run, context, carry, size, summary };
        return inHand;
      },
    };
  }

  // The stored Markdown of `run`, a run of `doc` that `#keyed` handed with `alone`: one row,
  // read by the run's key; what is stored there that is no Markdown this code stored is the run
  // rendered alone, as a missing row is. `undefined` where that shows the list is not this
  // code's.
  #markdownOf(
    doc: string, run: RunRow, alone: () => RenderedRun | undefined,
  ): string | undefined {
    // `one()`: the join said the row is there, and nothing was awaited since.
    let { md } = this.#storage.sql.exec<{ md: string }>(
      `SELECT md ${MARKDOWN_KEY} AND made = ? ${IN_DOC}`,
      run.run, run.context, run.carry, this.#made, doc,
    ).one();
    return markdownFromStored(md) ?? alone()?.markdown;
  }

  // Renders ONE stored run of a version keyed under the store's digest, alone: decodes it at
  // its place (its first index `at.first`, its footnote base the carry's), asks the walk's
  // `contexts` for the definitions of the lists it names and the named styles (`at.place` is
  // the run's place in the version's list), renders it with `at.carry` (a carry moved over
  // the summaries of the runs before it), and writes its row under the key the list names,
  // over a row that does not read back. No other run is decoded and no tab is rendered.
  // Counts a run decoded and a run rendered. `undefined`, with nothing written, where the
  // keys that come out are not the ones the list names: the list is then not what this code
  // makes of the version, which the caller keys again whole. What the renderer throws passes
  // as it is, a read being outside any edit, unless the read is `marked` as one made for an
  // edit (`renderedStored`).
  #renderAt(
    version: DocVersion, run: RunRow,
    at: { readonly place: number; readonly first: number; readonly carry: RenderCarry },
    contexts: RunContexts, marked = false,
  ): RenderedRun | undefined {
    let decoded = this.#decoded(
      version, run.run, { first: at.first, footnotes: at.carry.footnoteBase });
    let context = decoded && contexts(at.place, decoded.elements);
    if (!decoded || !context) return this.#unreadable(version.doc);
    let { elements } = decoded;
    let rendered = renderedStored(marked, () => renderRun(elements, context, at.carry, { mdStart: 0 }));
    docStoreCost.runsRendered++;
    let entry = listEntry(run.run, run.size, rendered.summary, context, at.carry);
    if (entry.context !== run.context || entry.carry !== run.carry) return undefined;
    this.#putMarkdown(
      version.doc, run, runNamed(version.tabId, heldBy(decoded.elements)), at.first, rendered,
      true);
    return rendered;
  }

  // Keys a stored version from its stored runs, one run in hand at a time, in one transaction:
  // reads its list a page at a time with no join (under another digest no stored summary is
  // this code's), decodes each run at its place, renders it with the definitions of the lists
  // it names and the named styles (`#contexts`: a page's lists by one statement, never the
  // whole context), stores its rendering, writes its key in the list in place (the renderings
  // another digest made under the keys the list held are removed first), and records `keyed`.
  // Every run is rendered: under another digest no stored rendering is this code's. In hand:
  // one page of the list, one run and one page's definitions. For a version not keyed under
  // the store's digest, and for one whose list a run rendered alone showed is not this
  // code's. Unreadable where a row is missing. What the renderer throws passes as it is
  // unless the read is `marked` (`renderedStored`).
  #rekey(version: DocVersion, marked = false): void {
    let keyed = this.transaction(() => {
      let row = this.#rows<VersionRow>(VERSION, version.doc, version.id)[0];
      let stored = this.#rows<{ derived: string }>(VERSION_DERIVED, version.doc, version.id)[0];
      let [total] = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, version.id);
      if (row === undefined || stored === undefined || total.runs === 0) return false;
      let list = this.#listWriter(version.doc, version.id, true);
      let state = keyingFrom(version.doc, version.bodyEndIndex - total.size);
      let contexts = this.#contexts(version.doc, row.context, version.id);
      let next = this.#pages(version, 0, "none");
      let place = 0;
      for (let listed = next(); listed !== undefined; listed = next(), place++) {
        let { run, size } = listed;
        let decoded = this.#decoded(
          version, run, { first: state.first, footnotes: state.carry.footnoteBase });
        let context = decoded && contexts(place, decoded.elements);
        if (!decoded || !context) return false;
        let { elements } = decoded;
        let rendered = renderedStored(
          marked, () => renderRun(elements, context, state.carry, { mdStart: 0 }));
        docStoreCost.runsRendered++;
        list.add(this.#keyRun(
          version.tabId, { id: run, size, holds: heldBy(decoded.elements) }, context, state,
          rendered));
      }
      list.end();
      let unindexed = derivedUnder(stored.derived, this.#made)?.unindexed;
      this.#rows(PUT_DERIVED, version.doc, version.id, JSON.stringify({
        made: this.#made, ...(unindexed === undefined ? {} : { unindexed }), keyed: true,
      }));
      return true;
    });
    // Outside the transaction, whose rows a throw would put back: the copy is dropped.
    if (!keyed) this.#unreadable(version.doc);
  }

  // What `read` answers of `version`, for a read that must answer. Where it answers nothing
  // (the version is not keyed under the store's digest, or its list is not what this code makes
  // of it), the version is keyed again whole, before any rendering is looked up for it, and
  // read once more; a version that answers nothing then is unreadable. `read` starts its
  // answer afresh at each call. `marked` says the read is made for an edit (`renderedStored`).
  #reading<T>(version: DocVersion, read: () => T | undefined, marked = false): T {
    let found = read();
    if (found !== undefined) return found;
    this.#rekey(version, marked);
    return read() ?? this.#unreadable(version.doc);
  }

  /**
   * The Markdown of `version`: the stored Markdown of its runs, joined in order. Decodes no run
   * and renders none where every run's rendering is stored under the store's digest. A RUN
   * WHOSE ROW IS MISSING, or whose stored Markdown or summary does not read back, IS RENDERED
   * ALONE: that run decoded at its place, rendered with the carry the stored summaries of the
   * runs before it give, and its row written under the key the list names; no other run is
   * decoded and no tab is rendered. A version that is not keyed under the store's digest (a
   * base version kept across a change of the code) is keyed first: each of its runs decoded,
   * one at a time, and rendered with the carry of the one before, its rendering stored and its
   * key written in the version's list in place, before any rendering is looked up.
   * WHAT IT HOLDS: the Markdown it answers, once as a string a run and once joined, and one
   * page of the version's list at a time; no carry and nothing for a list where every
   * rendering is stored.
   */
  markdown(version: DocVersion): string {
    let markdown = this.#reading(version, () => {
      let parts: string[] = [];
      let keyed = this.#keyed(version, (run, alone) => {
        let part = this.#markdownOf(version.doc, run, alone);
        if (part === undefined) return false;
        parts.push(part);
        return true;
      });
      if (!keyed) return undefined;
      return parts.length === 1 ? parts[0] : parts.join("");
    });
    markdownInHand(markdown);
    return markdown;
  }

  /**
   * The summary of `version`'s rendering, its runs' summaries joined (`summaryJoiner`) as its
   * list is read, a statement a page, with no Markdown read; a run with no rendering is
   * rendered alone, and a version not keyed under the store's digest keyed first, as
   * `markdown` does. The answer holds the fields of `DocRunSummary` AND NO OTHER, for a
   * version of one run as for one of many: what a stored summary holds beside them (the
   * renderer's summary of the run) is the store's own. A table's `start` is counted from the
   * tab's first index. NO READER OF A DOCUMENT CALLS IT: what an edit or its card asks of a
   * tab as a whole is asked of a walk or a reader, a page at a time. It is what the tests
   * hold a version's summaries to.
   * WHAT IT HOLDS: its answer, which lists every table of the tab, and one page of the
   * version's list at a time; no carry where every rendering is stored.
   */
  summary(version: DocVersion): DocRunSummary {
    return this.#reading(version, () => {
      let joined = summaryJoiner();
      let keyed = this.#keyed(version, run => {
        joined.add(run);
        return true;
      });
      return keyed && joined.end();
    });
  }

  /**
   * Hands `each` the runs of `version` at places `[from, to)`, in order, until it answers
   * `false` or they end: each with the summary stored with its rendering and, where `each`
   * asks, its stored Markdown. No run is decoded and none rendered where its rendering is
   * stored under the store's digest; a run whose rendering is missing or does not read back
   * is rendered alone and a version not keyed under the store's digest keyed first, as
   * `markdown` does (`each` may then be handed the runs again from `from`: it starts its
   * answer afresh at the run of place `from`). HOLDS one page of the list, the run in hand
   * and nothing of the runs passed.
   * @throws `DocRunRenderError` for what the renderer throws on a run rendered here (alone,
   * or as the version is keyed): a fault of the tab, not of storage, which is the edit's
   * refusal where the walk is read for an edit. As `tab` does where the version cannot be
   * read back.
   */
  walk(version: DocVersion, each: (run: StoredRun) => boolean, from = 0, to = Infinity): void {
    this.#reading(version, () => {
      // A run whose Markdown shows the list is not this code's: the walk ends there, and the
      // version is keyed again and walked once more.
      let stale = false;
      return this.#keyed(version, (run, alone, place) => {
        let more = each(storedRun(run, place, () => {
          let markdown = this.#markdownOf(version.doc, run, alone);
          if (markdown === undefined) stale = true;
          else markdownInHand(markdown);
          return markdown ?? "";
        }, this.#elements(version, run.run)));
        return !stale && (more || "done");
      }, from, to, true);
    }, true);
  }

  /**
   * A reader of `version`'s runs, one a call: forwards from the run at `place`, or with
   * `back` backwards from the run before `place`; `undefined` once the list is passed.
   * Each run is what `walk` hands for its place (its summary, and its stored Markdown read
   * where asked: one row), valid until the reader is asked again. A version not keyed under
   * the store's digest is keyed first, when the reader is made, and a run whose rendering
   * is missing is rendered alone and its row written, both as `walk` does: neither changes
   * a run's place or its Markdown. HOLDS one page of the list and the run in hand, and
   * nothing of the runs passed: its first page is a few runs and each page after it four
   * times as many, up to a full page, so a reader asked for a few runs reads a few rows.
   * Valid until the next await, as a version handle is.
   * @throws From a call, as `tab` does where the version cannot be read back, and
   * `DocRunRenderError` as `walk` does.
   */
  reader(version: DocVersion, place: number, back = false): () => StoredRun | undefined {
    let from = (at: number) => this.#keyedRuns(version, at, Infinity, true, back, RUN_LIST_FIRST);
    let runs = this.#reading(version, () => from(place), true);
    // Where a run shows that the list is not this code's, the version is keyed again whole
    // and read on from the run in hand, which keeps its place.
    let again = (): KeyedRun | undefined => {
      this.#rekey(version, true);
      runs = from(back ? runs.place + 1 : runs.place) ?? this.#unreadable(version.doc);
      let run = runs.next();
      return run === false ? this.#unreadable(version.doc) : run;
    };
    return () => {
      let run = runs.next();
      if (run === false) run = again();
      if (run === undefined) return undefined;
      let listed = run;
      return storedRun(listed, runs.place, () => {
        let markdown = this.#markdownOf(version.doc, listed, runs.alone);
        if (markdown === undefined) {
          let keyed = again();
          markdown = keyed && this.#markdownOf(version.doc, keyed, runs.alone);
        }
        if (markdown === undefined) return this.#unreadable(version.doc);
        markdownInHand(markdown);
        return markdown;
      }, this.#elements(version, listed.run));
    };
  }

  /**
   * Where the lists of runs of two versions of one tab differ: `before`'s runs at places
   * `[from, beforeTo)` stand where `after`'s at `[from, afterTo)` do, and every other entry
   * is the same entry (run, context key and carry key, so the same rendering) at the same
   * place counted from the list's start, before `from`, or from its end, after. Entries
   * that differ may still read the same (one Markdown under two keys): a caller that needs
   * to know reads them. IT ANSWERS PLACES AND NOTHING ELSE. INSIDE ITS RANGE THE TWO LISTS'
   * PLACES DO NOT LINE UP: the runs an edit touched are cut again when its version is stored,
   * so text that reads as before may stand there in other runs, with other ends. The range
   * is therefore not the runs a card shows: it says only outside which places the two
   * versions read alike with nothing read. Answered inside storage, by two statements over
   * the lists' keys; no entry reaches the isolate. Asked of two versions keyed under the
   * store's digest, as the version an edit was made in and the one it gave are.
   */
  changed(before: DocVersion, after: DocVersion): { from: number; beforeTo: number; afterTo: number } {
    let [{ runs }] = this.#rows<{ runs: number }>(RUNS_TOTAL, before.id);
    let [listed] = this.#rows<{ runs: number }>(RUNS_TOTAL, after.id);
    let more = listed.runs - runs;
    let from = this.#rows<{ place: number }>(FIRST_UNLIKE, before.id, after.id)[0]?.place ?? runs;
    let last = this.#rows<{ place: number }>(LAST_UNLIKE, before.id, after.id, more, from)[0];
    let beforeTo = last === undefined ? from : last.place + 1;
    return { from, beforeTo, afterTo: beforeTo + more };
  }

  // What an attempt of a piece and a scout start with (`#pieced`, `#scouted`): a pass over
  // `version`'s list from place `from`, to render each run it takes. Asks the keyed record
  // as `#sliced` does, the version's totals, then the state at `from` from the stored
  // summaries of the runs before it (`#stateAt`), with how much Markdown and how many
  // tables those runs write (`before`); the list is read from `from` with no join (no
  // summary is needed of a run that is rendered). `undefined` where the version is not
  // keyed under the store's digest or a summary before `from` does not read back.
  // `at` IS HELD TO WHAT IS STORED: a place that is no place of the version's list (past
  // it, before it, or no whole number: no pass from such a place reaches a run), a last
  // element asked for at a run that is not the last, or own elements that stand before the
  // run named, names nothing of the version; and so does, where the pass reaches the run it
  // names (`named`), a Markdown offset or a count of tables that the runs before do not
  // write. WHAT IS NO NUMBER HOLDS NOTHING: each comparison is written so that `NaN`, and
  // what an array read past its end hands a caller, fails it, in the place, the own
  // table's number and both ends of the own Markdown range (an end that is no number would
  // never be whole in hand, and every run to the tab's end would be added for it).
  #pieceWalk(version: DocVersion, at: PieceAt, from: number) {
    let record =
      this.#rows<{ context: string; derived: string }>(VERSION_KEYS, version.doc, version.id)[0];
    if (record === undefined || !derivedUnder(record.derived, this.#made)?.keyed) return undefined;
    let [total] = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, version.id);
    if (total.runs === 0) return this.#unreadable(version.doc);
    let { own } = at;
    let listed = Number.isInteger(at.place) && at.place >= 0 && at.place < total.runs;
    let held = own === "end"
      ? at.place === total.runs - 1
      : "table" in own
        ? own.table >= at.tablesBefore
        : own.markdown.mdStart >= at.mdStart &&
          !Number.isNaN(own.markdown.mdEnd - own.markdown.mdStart);
    if (!listed || !held) throw new DocPieceError(PIECE_NAMES_NOTHING);
    let before = { markdown: 0, tables: 0 };
    let state = this.#stateAt(version, from, before, total);
    if (!state) return undefined;
    let next = this.#pages(version, from, "none");
    return {
      runs: total.runs, before, state,
      contexts: this.#contexts(version.doc, record.context, version.id),
      // The run at the pass's next place: a list that ends before the run `at` names is
      // not the list the totals were of.
      next: (): ListedRun => next() ?? this.#unreadable(version.doc),
      // Throws where the runs before the one `at` names, which wrote `markdown` characters
      // and `tables` tables since `from`, do not put it where `at` says it stands.
      named(markdown: number, tables: number): void {
        if (before.markdown + markdown !== at.mdStart || before.tables + tables !== at.tablesBefore) {
          throw new DocPieceError(PIECE_NAMES_NOTHING);
        }
      },
    };
  }

  // ONE RUN of a piece or of a scout, IN A FRAME OF ITS OWN, so that its elements are let
  // go before the next run is decoded: the run decoded at its place with every index it
  // has in the tab (`exact`, which renders as the version's own word does), rendered with
  // the lists its page names (`contexts`), the pass's carry as it stands and its elements
  // told, its Markdown placed at `at.mdStart`; then the pass is moved past it (`passed`).
  // Notes each element's start and end in `indexes` where given, and answers the decoded
  // run only where `keep` asks: it is reachable from nothing else once this returns.
  // Counts a run decoded and a run rendered. Unreadable where the run or the context is
  // missing or is not one, or the run holds no element and is not the version's only run;
  // what the renderer throws is a `DocRunRenderError`.
  #rendered(
    version: DocVersion, listed: RunRow, state: Keying,
    at: { readonly place: number; readonly alone: boolean; readonly mdStart: number },
    contexts: RunContexts, keep: boolean, indexes?: ElementIndexes,
  ): {
    rendered: RenderedRun; told: RunElements;
    decoded?: { elements: StructuralElement[]; footnotes: number };
  } {
    let decoded = this.#decoded(
      version, listed.run, { first: state.first, footnotes: state.carry.footnoteBase }, true);
    let context = decoded && contexts(at.place, decoded.elements);
    if (!decoded || !context || (decoded.elements.length === 0 && !at.alone)) {
      return this.#unreadable(version.doc);
    }
    let rendered: RenderedRun;
    try {
      rendered = renderRun(
        decoded.elements, context, state.carry, { mdStart: at.mdStart, elements: true });
    } catch (thrown) {
      throw new DocRunRenderError(thrown);
    }
    docStoreCost.runsRendered++;
    let told = rendered.elements;
    if (!told) throw new Error("A run rendered for a piece says nothing of its elements");
    if (indexes) {
      let end = state.first;
      for (let element of decoded.elements) {
        indexes.starts.push(Number.isInteger(element.startIndex) ? element.startIndex : end);
        if (Number.isInteger(element.endIndex)) end = element.endIndex;
        indexes.ends.push(end);
      }
    }
    passed(state, rendered.summary, listed.size);
    return keep ? { rendered, told, decoded } : { rendered, told };
  }

  // A SCOUT of the `back` runs before the run `at` names, for a piece whose closure starts
  // before the run before it: the pass from place `at.place - back` (`#pieceWalk`), its
  // runs and the one `at` names rendered one at a time (`#rendered`), each in a frame that
  // keeps of it its elements' flags, gathered in one array, and how many elements, how
  // much Markdown and how many tables stand before the next; the first own element is
  // found in the run `at` names (`ownFirstIn`) and the closure's start asked of the flags
  // (`closureStart`). Answers the place of the run that closure starts in; `"before"` where
  // it starts before the runs scouted, which a scout from the tab's first run never
  // answers; `undefined` as `#pieceWalk` does. THE PLACE ANSWERED IS AT OR BEFORE THE RUN
  // THE PIECE'S CLOSURE STARTS IN, and is that run but in one case: a Markdown range that
  // starts at the tab's end, where runs that write nothing follow the run named. There an
  // attempt finds the own element in a later run (`#pieced`: the last element that starts
  // at or before the offset, of every run joined) and a scout in the run named, so the
  // closure a scout asks for may start earlier than the piece's; an attempt from the place
  // answered then renders runs before its closure and cuts them off. IN HAND: the run in
  // the frame, a byte an element of the runs scouted (under two with the array's room to
  // grow) and four bytes a run. Counts the Markdown of each run alone.
  #scouted(version: DocVersion, at: PieceAt, back: number): number | "before" | undefined {
    let from = at.place - back;
    let walk = this.#pieceWalk(version, at, from);
    if (!walk) return undefined;
    let flags = flagsGathered();
    // How many elements the runs scouted hold through each of them.
    let through = new Uint32Array(back + 1);
    let elements = 0, markdown = 0, tables = 0, first = -1;
    let one = (place: number): void => {
      if (place === at.place) walk.named(markdown, tables);
      let { rendered, told } = this.#rendered(
        version, walk.next(), walk.state,
        { place, alone: walk.runs === 1, mdStart: markdown }, walk.contexts, false);
      markdownHeld(rendered.markdown.length);
      if (place === at.place) {
        let own = ownFirstIn(told, at, markdown);
        if (own < 0) throw new DocPieceError(PIECE_NAMES_NOTHING);
        first = elements + own;
      }
      flags.add(told.flags);
      elements += told.flags.length;
      through[place - from] = elements;
      markdown += rendered.markdown.length;
      tables += rendered.sourceMap.tables.length;
    };
    for (let place = from; place <= at.place; place++) one(place);
    let start = closureStart(flags.all(), first, from === 0);
    return start === undefined ? "before" : from + through.findIndex(count => count > start);
  }

  // ONE ATTEMPT at a piece, from run `from`: the pass from there (`#pieceWalk`), the runs
  // up to the one `at` names rendered and joined, then one run more while the own range
  // is not whole in hand, and one more while its closure runs out after (`closureOf`):
  // each counts a widening. Answers the piece, cut from the joined runs at the closure
  // (`pieceRendering`); `"before"` where the closure starts before run `from`, WITH
  // NOTHING OF THE ATTEMPT REACHABLE FROM THE ANSWER, and before a run is added after;
  // `undefined` as `#pieceWalk` does.
  // THE OWN ELEMENTS are found among the elements joined, from the first of the run `at`
  // names: for a Markdown range, the last element that starts at or before its first
  // character and the last that starts at or before its last (an empty range's one place),
  // whole in hand once the joined Markdown passes that character; for a table, the
  // element of the run `at` names that owns the table of its number less those before the
  // run (`ownFirstIn`: a table in a later run is not at the run named, by `PieceAt`'s
  // rule); for `"end"`, the last element. A range no element of those runs holds names
  // nothing of the version.
  // KEPT DECODED: the run before the one `at` names, that run, and each run after it that
  // was added while the own range was not whole in hand: none after the run that holds
  // the range's last element.
  #pieced(version: DocVersion, at: PieceAt, from: number): DocPiece | "before" | undefined {
    let walk = this.#pieceWalk(version, at, from);
    if (!walk) return undefined;
    let origin = walk.state.first;
    let joined = noRenderedRuns();
    let indexes: ElementIndexes = { starts: [], ends: [] };
    let decoded: DocPiece["decoded"] = new Map();
    // How many elements are joined through each run in hand, and the next run's place.
    let through: number[] = [];
    let place = from;
    // Whether the own range is whole in hand.
    let covered = false;
    let add = (): RunElements => {
      let run = this.#rendered(
        version, walk.next(), walk.state,
        { place, alone: walk.runs === 1, mdStart: joined.markdown.length }, walk.contexts,
        place >= at.place - 1 && !covered, indexes);
      joinRenderedRun(joined, run.rendered);
      if (run.decoded) decoded.set(place, run.decoded);
      through.push(joined.flags.length);
      place++;
      return run.told;
    };
    while (place < at.place) add();
    walk.named(joined.markdown.length, joined.sourceMap.tables.length);
    // What is joined before the run `at` names.
    let base = { markdown: joined.markdown.length, elements: joined.flags.length };
    let named = add();
    let { own } = at;
    // The own range so far: it only moves forward as runs are added.
    let first = base.elements, last = base.elements;
    if (own !== "end" && "table" in own) {
      // As a scout finds it: in the run named, or nowhere.
      let table = ownFirstIn(named, at, base.markdown);
      if (table < 0) throw new DocPieceError(PIECE_NAMES_NOTHING);
      first = last = base.elements + table;
      covered = true;
    }
    let found = (ended: boolean): OwnElements | undefined => {
      let { starts, flags } = joined;
      if (own === "end") {
        covered = ended;
        first = last = flags.length - 1;
      } else if ("markdown" in own) {
        let low = base.markdown + own.markdown.mdStart - at.mdStart;
        let high = low + Math.max(0, own.markdown.mdEnd - 1 - own.markdown.mdStart);
        if (ended && low > joined.markdown.length) return undefined;
        while (first + 1 < starts.length && starts[first + 1] <= low) first++;
        last = Math.max(last, first);
        while (last + 1 < starts.length && starts[last + 1] <= high) last++;
        covered = joined.markdown.length > high;
      }
      // A body of no element is one run of none: its own range holds none.
      return flags.length === 0 ? { first: 0, last: -1 } : { first, last };
    };
    for (;;) {
      let ended = place === walk.runs;
      let range = found(ended);
      if (!covered && !ended) {
        add();
        continue;
      }
      if (!range) throw new DocPieceError(PIECE_NAMES_NOTHING);
      let elements = joined.flags.length;
      let closure = elements === 0
        ? { from: 0, to: 0 }
        : closureOf(joined.flags, range, { first: from === 0, last: ended });
      if ("more" in closure && closure.more === "after") {
        docStoreCost.pieceWidenings++;
        add();
        continue;
      }
      markdownHeld(joined.markdown.length);
      if ("more" in closure) return "before";
      let cut = pieceRendering(joined, closure.from, closure.to);
      return {
        version, decoded,
        from: from + Math.max(0, through.findIndex(count => count > closure.from)),
        to: from + 1 + Math.max(0, through.findIndex(count => count >= closure.to)),
        rendering: {
          ...tabIdentity(version), markdown: cut.markdown, sourceMap: cut.sourceMap,
          bodyEndIndex: version.bodyEndIndex,
        },
        at: {
          mdStart: walk.before.markdown + cut.mdStart,
          tablesBefore: walk.before.tables + cut.tablesBefore,
          first: from === 0 && closure.from === 0,
          last: ended && closure.to === elements,
          inner: elements === 0
            ? { from: origin, to: origin }
            : { from: indexes.ends[closure.from], to: indexes.starts[closure.to - 1] },
        },
      };
    }
  }

  /**
   * The piece of `version` around `at.own`. The runs from `at.place` on that hold the own
   * elements are decoded at their place and rendered, each in a frame of its own, with the
   * carry the stored summaries of the runs before give and with their elements told
   * (`RunPlace.elements`); the closure is asked of what is in hand (`closureOf`), and while
   * it answers `more` runs are added. AFTER: the next run, rendered with the carry as it
   * stands. BEFORE, since a carry is only moved forward: everything is let go and made
   * again one run earlier; where that is not enough, the runs before are SCOUTED, 2 and
   * then 4, 8, ... of them to the tab's first, each rendered for its elements' flags alone
   * and let go, until a scout names the run its closure starts in (`closureStart`), and the
   * piece is made once more from that run. A SCOUT'S START IS AT OR BEFORE THE RUN THE
   * PIECE'S CLOSURE STARTS IN, and is that run but for a Markdown range that starts at the
   * tab's end where runs that write nothing follow the last run that writes: an attempt
   * finds the own element in the last of those and a scout in the run named, so the
   * scout's closure may start earlier, and the last attempt renders the runs between and
   * cuts them off. The piece is the closure exactly either way (`pieceRendering` of the
   * runs joined, which hold it). ONE ATTEMPT IS IN HAND AT A TIME, and of an attempt: the
   * renderings of its runs, the decoded elements of the run before `at.place` and of the
   * own runs, and the run in the frame; a scout holds a byte an element (under two with
   * the room its array grows into), four bytes a run and the run in the frame. Counts each
   * run decoded and rendered, the joined Markdown in hand, and each attempt after the
   * first, scouts included, and each run added after the own elements (`pieceWidenings`).
   *
   * WHAT IT COSTS, with `O` the runs of the own elements, `B` the runs of the closure
   * before `at.place` and `A` those after the own. Runs decoded and rendered: `O + A` where
   * `B` is 0; `O`, and then `1 + O + A`, where it is 1 (an attempt that finds its closure
   * starts earlier adds no run after); beyond, `O` and `1 + O`, then scouts of `back + 1`
   * runs for `back` = 2, 4, ... until `back` reaches `B` or the place, then `B + O + A`;
   * with the scout's start for `B` where it is the earlier (the range at the tab's end
   * above), which is more scouts and a longer last attempt, and the same piece.
   * Rows: for each attempt and scout the version's keys and totals, one walk of the list's
   * summaries from place 0 to the run it starts at (a row of the list and the rendering it
   * names, a page a statement), the list from there with no join, the lists a page's runs
   * name, and each run rendered by its id.
   *
   * WHAT IT WRITES: nothing of its own, and what a read writes. A version not keyed under
   * the store's digest, or one whose stored summaries before the piece do not read back,
   * is keyed again whole first, in a transaction of that keying's own. Inside a
   * transaction or a trial of the caller's those rows are the caller's to keep or to undo
   * with the rest: nothing here depends on their being kept.
   * @throws `DocRunRenderError` for what the renderer throws on a run; a `DocPieceError`
   * where `at` does not name the version's runs (its place is no place of the list, the
   * runs before it do not write the Markdown and the tables `at` says stand before it, a
   * table of `at.own` is not in the run at `at.place`, or no element of its Markdown range
   * is in the runs from `at.place` on) or the closure starts before the run it was found
   * to start in; and as `tab` does where the version cannot be read back.
   */
  piece(version: DocVersion, at: PieceAt): DocPiece {
    return this.#reading(version, () => {
      let found = this.#pieced(version, at, at.place);
      if (found !== "before") return found;
      docStoreCost.pieceWidenings++;
      found = this.#pieced(version, at, at.place - 1);
      // A scout from the tab's first run holds the tab's first element, and names a run.
      for (let back = 2; found === "before"; back *= 2) {
        docStoreCost.pieceWidenings++;
        let start = this.#scouted(version, at, Math.min(back, at.place));
        if (start === "before") {
          if (back >= at.place) throw new DocPieceError(PIECE_STARTS_BEFORE);
          continue;
        }
        if (start === undefined) return undefined;
        docStoreCost.pieceWidenings++;
        found = this.#pieced(version, at, start);
        if (found === "before") throw new DocPieceError(PIECE_STARTS_BEFORE);
      }
      return found;
    }, true);
  }

  /**
   * The runs of `version` that hold what `reach` names, decoded at their place: found from
   * the version's list of runs alone (the running sum of the runs' sizes), with no content
   * read to choose them. The run that holds an index is the last whose first index is not
   * past it; an index before the tab is in the first run and one at or past its end in the
   * last. The slice holds the runs from the one of `reach.from` to the one of `reach.to`,
   * and the run before them where an index of `reach.behind` is the first index of the
   * slice's first run (the request reads the element before it). With no `reach`, the
   * tab's first run.
   *
   * Each run is decoded once (`runsDecoded`), one run's JSON in hand at a time, with every
   * index it has in the tab and the opening section break's start; `piece.footnotesBefore`
   * is the count the stored summaries of the runs before give. `piece.lists` holds the
   * definition of each list the slice's paragraphs name and an empty definition for every
   * other id of the version's context that starts with `MODEL_LIST_ID`: no other list of
   * the tab reaches the isolate, by its definition or by its id. The shared data is read
   * once a slice, after its runs are decoded: three statements over the context (its named
   * styles, the slice's lists by id, the model's ids), two where the slice names no list.
   *
   * THE LIST IS READ A PAGE AT A TIME, from its first run to the run after the slice's
   * last: of the runs before the slice it holds the page in hand, a running sum of sizes
   * and the carry, moved over each run's stored summary as it passes. Nothing is held for
   * every run, whatever the tab's length. A run before the slice with no rendering stored is
   * rendered alone first, and a version not keyed under the store's digest keyed first, as
   * `markdown` does.
   *
   * A version the model cannot follow (`unindexed`) is not to be sliced: its indexes are
   * not the model's. The caller answers for it; the store does not ask.
   *
   * A run `decoded` holds at its place is taken from it (and out of it) and not decoded
   * again: the piece an edit's builders read decoded it with the same indexes and the same
   * footnote base. A run it does not hold is decoded here.
   * @throws As `tab` does where the version cannot be read back.
   */
  slice(version: DocVersion, reach?: BatchReach, decoded?: DocPiece["decoded"]): DocSlice {
    let pick: SlicePick = reach
      ? { low: reach.from, high: reach.to, behind: reach.behind }
      : { from: 0, to: 1, behind: [] };
    return this.#reading(version, () => this.#sliced(version, pick, undefined, decoded));
  }

  /**
   * `slice` again with more runs, for a batch that read past an edge of the runs at `held`:
   * those runs and, on `edge.side`, every run up to the one `edge.index` falls in by the
   * version's STORED sizes, one more run at least. For `before` that is the run the read
   * wanted. FOR `after` IT IS A GUESS (`SliceEdgeError.index`): the index is in the
   * coordinates the failed attempt's earlier requests moved, so after a long insertion it
   * falls past the run the batch reads (runs are decoded that the batch never reads) and
   * after a deletion short of it (the next attempt reads past the edge again and widens
   * again, a run at least each time). Nothing takes the move off: the attempt's draft is
   * gone, and the model says nothing of it. The outcome is the whole tab's either way; the
   * cost is counted (`runsDecoded`, `viewWidenings`). Decoded FROM STORAGE, shared data
   * included. IT IS HANDED THE PLACES AND NEVER THE SLICE: the piece a failed attempt
   * changed is not read and is not reachable from this call, so its caller can have let it
   * go before the wider one is decoded (one slice in hand at a time, not two). Counts a
   * widening (`viewWidenings`). A slice that holds every run is the whole tab, which no
   * batch reads past.
   * @throws `edge` itself where there is no run on that side (`held.from` is 0 for
   * `before`; `held.to` is the number of runs the version lists for `after`), before a run
   * is read: a fault of whoever threw it.
   */
  widen(version: DocVersion, held: RunPlaces, edge: SliceEdgeError): DocSlice {
    let pick: SlicePick = edge.side === "before"
      ? { from: held.from - 1, low: edge.index, to: held.to, behind: [] }
      : { from: held.from, to: held.to + 1, high: edge.index, behind: [] };
    let slice = this.#reading(version, () => this.#sliced(version, pick, edge));
    docStoreCost.viewWidenings++;
    return slice;
  }

  // THE ONE WALK `slice` and `widen` end in: the runs `pick` takes of `version`, decoded at
  // their place, with the tab's shared data and the two carries. `undefined` where the
  // version is not keyed under the store's digest or a run rendered alone shows its list is
  // not this code's (`#reading` keys it and walks once more). `outside` is thrown, before a
  // run is read, where the places `pick` names are not places of the list. A run `taken`
  // holds at its place is taken out of it in place of a decode (`slice`).
  // THE LIST PASSES A PAGE AT A TIME (`#pages`), one row read ahead: that there is none says
  // the row in hand is the tab's last, and the next row's first index says which run holds
  // an index. Of a run passed nothing is kept but the row and the summary of THE RUN BEFORE
  // the one in hand.
  // THE WALK OWNS ONE CARRY AND MOVES IT ONE RUN LATE: the carry in hand is the carry INTO
  // the run before the one in hand, moved over that run's summary only once the row after
  // it shows the slice does not start with it. So a slice that starts one run earlier, for
  // `behind`, starts with the carry in hand, and no carry is copied or moved back. AT THE
  // SLICE'S FIRST RUN the pair is made of that carry (`besideOf`), and from there the walk
  // moves THE OTHER SIDE over the stored summary of each run of the slice: the pass's own
  // stays the carry into the slice, and the other is the version's carry after it.
  // A run with no stored rendering is rendered alone (`#renderAt`) with the carry into it as
  // the version is stored: the pass's own before the slice, the other side's inside it.
  #sliced(
    version: DocVersion, pick: SlicePick, outside?: Error, taken?: DocPiece["decoded"],
  ): DocSlice | undefined {
    let [total] = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, version.id);
    if (total.runs === 0) return this.#unreadable(version.doc);
    if (outside && ((pick.from ?? 0) < 0 || (pick.to ?? 0) > total.runs)) throw outside;
    let record =
      this.#rows<{ context: string; derived: string }>(VERSION_KEYS, version.doc, version.id)[0];
    if (record === undefined || !derivedUnder(record.derived, this.#made)?.keyed) return undefined;
    let state = keyingFrom(version.doc, version.bodyEndIndex - total.size);
    let contexts = this.#contexts(version.doc, record.context, version.id);
    let next = this.#pages(version);
    let content: StructuralElement[] = [];
    let carries: CarryBeside | undefined;
    // The slice's first place and first index, and the footnote references before it and
    // before the run to decode next.
    let from = 0, origin = 0, footnotesBefore = 0, footnotes = 0;
    // Takes one run of the slice into the piece and moves the other side past it. `false`
    // where the run, rendered alone, shows the list is not this code's.
    let hold = (
      pair: CarryBeside, run: ListedRun, at: { readonly place: number; readonly first: number },
      summary: RunSummary | undefined,
    ): boolean => {
      summary ??= this.#renderAt(version, run, { ...at, carry: pair.theirs }, contexts)?.summary;
      if (!summary) return false;
      let decoded = taken?.get(at.place) ??
        this.#decoded(version, run.run, { first: at.first, footnotes }, true);
      taken?.delete(at.place);
      if (!decoded || (decoded.elements.length === 0 && total.runs > 1)) {
        return this.#unreadable(version.doc);
      }
      for (let element of decoded.elements) content.push(element);
      footnotes += decoded.footnotes;
      pair.advanceTheirs(summary);
      return true;
    };
    let before: { readonly run: ListedRun; readonly summary: RunSummary } | undefined;
    // The place and the first index of the row in hand: sums of the walk's own, since the
    // carry's stand one run behind.
    let place = 0, first = state.first;
    for (let listed = next(); listed !== undefined; place++) {
      let ahead = next();
      if (!carries) {
        let takes = (pick.from !== undefined && place >= pick.from) ||
          (pick.low !== undefined && (!ahead || first + listed.size > pick.low));
        // The run before starts the slice where a bulleted range starts at this run's first
        // index: the carry in hand is the carry into it.
        let behind = takes && pick.behind.includes(first) ? before : undefined;
        if (before && !behind) passed(state, before.summary, before.run.size);
        if (takes) {
          carries = besideOf(state);
          from = behind ? place - 1 : place;
          origin = state.first;
          footnotes = footnotesBefore = state.carry.footnoteBase;
          if (behind && !hold(carries, behind.run, { place: from, first: origin }, behind.summary)) {
            return undefined;
          }
        }
      }
      if (carries) {
        if (!hold(carries, listed, { place, first }, summaryOf(listed))) return undefined;
        let ends = (pick.to === undefined || place >= pick.to - 1) &&
          (pick.high === undefined || first + listed.size > pick.high);
        if (ends || !ahead) {
          return {
            version, from, to: place + 1, carries,
            piece: {
              tabId: version.tabId, ...this.#sharedBy(version, record.context, content),
              content, origin, first: from === 0, last: !ahead, footnotesBefore,
            },
          };
        }
      } else {
        // The carry in hand is the carry into this run.
        let summary = summaryOf(listed) ??
          this.#renderAt(version, listed, { place, first, carry: state.carry }, contexts)?.summary;
        if (!summary) return undefined;
        before = { run: listed, summary };
      }
      first += listed.size;
      listed = ahead;
    }
    // The list ended before a run the pick names: it is not the list the totals were of.
    return this.#unreadable(version.doc);
  }

  // The shared data of a slice whose decoded elements are `content`, read ONCE A SLICE from
  // the context stored as `context`: its named styles (`STYLES_OF`); the definitions of the
  // lists `content` names, ASKED FOR BY ID (`LISTS_OF`, not run where it names none: the
  // slice is in hand, so its ids cost nothing to read and no stored run is read for them);
  // and an empty definition for every other id the model could have made (`MODEL_LISTS_OF`,
  // ids only). No other list of the tab reaches the isolate. Unreadable where the context
  // is missing or is not one, or a definition is not a record.
  #sharedBy(
    version: DocVersion, context: string, content: readonly StructuralElement[],
  ): Pick<TabSlice, "lists" | "namedStyles"> {
    let styles = this.#stylesOf(version.doc, context);
    if (styles === null) return this.#unreadable(version.doc);
    let lists = new Map<string, unknown>();
    let named = namedListIds(content);
    let defined = named.length === 0 ? [] : this.#rows<{ id: string; definition: SqlStorageValue }>(
      LISTS_OF, context, JSON.stringify(named), version.doc);
    for (let { id, definition } of defined) {
      lists.set(id, listDefined(definition) ?? this.#unreadable(version.doc));
    }
    for (let { id } of this.#rows<{ id: string | null }>(
      MODEL_LISTS_OF, context, MODEL_LIST_ID, version.doc,
    )) {
      if (id !== null && !lists.has(id)) lists.set(id, {});
    }
    // Own properties, whatever the ids.
    return { lists: Object.fromEntries(lists) as GoogleDocsTab["lists"], ...styles };
  }

  /**
   * Stores the version a batch gives: `slice.version` with the runs of `slice` replaced by
   * `slice.piece.content` as the model left it (`made` is what the model answered for it),
   * and answers its handle. Every other run is listed as it was, by id, AND NEVER ENTERS
   * THE ISOLATE AS CONTENT: of a run before the slice its name passes (a page of names at a
   * time, for the version's id) and its entry is copied inside storage; of a run after the
   * slice the same, and where the carry moved, its entry and the stored summary of its
   * rendering, a page at a time. Nothing is held for every run.
   *
   * THE RUNS. The elements are cut by `cutRuns` (footnotes counted from
   * `piece.footnotesBefore`), between the two run boundaries the slice had: a slice that
   * grew is cut where the content rule cuts it, and its last run ends where the slice ended
   * whatever the rule would say there. A slice left with no element lists no run. So the
   * runs are those a cut of the whole tab would make up to the slice's last run, which may
   * be shorter than the rule makes one. NO EDIT JOINS A SHORT RUN TO ITS NEIGHBOUR: short
   * runs left by edits in one place add up until the document is fetched again, which is
   * the next approval or the next read of a changed revision; a base version is only ever
   * cut by a fetch.
   *
   * WHAT A LATER FETCH FINDS. A run is named by its bytes, and the elements the model
   * wrote are not Google's bytes (a paragraph's text and its newline are two text runs
   * here and one in Google's answer), so a fetch of the document after the edit is applied
   * stores and renders again every run that holds an element the edit wrote, whichever way
   * it was cut. The runs outside the slice are listed by the names a fetch gave them, and
   * a fetch finds them again with their renderings: that sharing is what an edit keeps.
   *
   * THE CONTEXT. Where the batch made no list, the version's context is its parent's row.
   * Where it made one (`made.lists`), the parent's context is read whole, the lists added in
   * the order they were made, and the result stored as the version's own: the one case in
   * which an edit holds every list of its tab.
   *
   * THE KEYS. Runs before the slice keep their entries. EACH run cut from the slice is
   * rendered from the elements in hand, the first with `slice.carries.ours`, and its
   * rendering stored where it is not (`runsRendered`): a run that came out as it went in
   * (the run taken for the element before a bulleted range, the runs of a span the batch
   * read and did not change) is rendered too, and writes no row where its rendering is
   * stored under the key it comes to (the parent's, where the carry into it is the
   * parent's). `runsRendered` moves by the runs cut, whatever the batch changed of them:
   * the price of holding nothing of the parent's list for the slice's own runs. Then, run
   * by run after the slice: while the carry is not the parent's at the same place, the
   * run's key is worked out of the carry and its stored summary (`runsKeyed`), and the run
   * is decoded at its place and rendered only where no rendering is stored under that key,
   * with the lists its page of the parent's list names, loaded by one statement a page and
   * never a statement a run (a run with no rendering stored under the parent's key has no
   * summary to work a key out of: it is decoded and rendered, and is not counted as keyed);
   * where the carry is the parent's again the walk has settled,
   * and every run from there on keeps its entry, copied inside storage. Where it never
   * settles (a list renumbered to its end, a footnote added or removed) the walk goes to
   * the tab's end, a page at a time. The walk states the rule of a tab keyed beside a stored
   * version (`#keyBeside`: re-key until the carry is the other version's again) by place and
   * not by id, since a child's later runs are its parent's at the parent's places: it reads
   * them a page at a time and needs no map of the other list.
   *
   * A LIST THE BATCH MADE IS NAMED BY NO RUN OUTSIDE THE SLICE, so no other run's context
   * key moves: that is why a run outside the slice keeps the parent's context key where
   * a fetched tab's keying beside the stored copy's asks each run again. It holds for every
   * version that takes an edit, and nothing is read to check it: the model names a list
   * `MODEL_LIST_ID` and a number, the lowest the tab does not define; a tab stored as
   * fetched that names such an id with no definition is not followed (`hasModelIndexes`),
   * so its edit is refused before a slice is asked for; and the model defines each id it
   * gives a paragraph and removes no definition, so the version an edit gives names none
   * without one either. (A tab stored from hand as the model's own, `putTab` of a tab
   * `isModelIndexed`, is taken at that word, as its indexes are.)
   *
   * The version is `exact`, its `bodyEndIndex` the parent's moved by `made.moved`, and it
   * carries the identity and the write markers of `slice.version`. A version found stored and
   * keyed under the store's digest is answered with nothing rendered. One transaction: a
   * throw leaves no row of it.
   * @throws `DocRowTooLargeError` for an element, a context or a run's Markdown too large for
   * a row; `DocRunRenderError` where the renderer throws on a run; an `Error` where `slice`
   * is not a slice of its version as it is stored (its places, its origin or its length do
   * not agree with the list), or the version would list no run: faults of the caller; and
   * as `tab` does where the version cannot be read back.
   */
  putSlice(slice: DocSlice, made: SliceResult): DocVersion {
    let lost = false;
    try {
      return this.transaction(() => {
        let child = this.#putSliced(slice, made);
        if (child) return child;
        lost = true;
        throw new Error(DOC_COPY_UNREADABLE);
      });
    } catch (thrown) {
      // Outside the transaction, whose rows the throw put back: the copy is dropped.
      if (lost) this.drop(slice.version.doc);
      throw thrown;
    }
  }

  // `putSlice`, inside its transaction. `undefined` where a row of the parent cannot be read
  // back: the caller undoes what was written and drops the copy.
  #putSliced(slice: DocSlice, made: SliceResult): DocVersion | undefined {
    let { version: parent, piece, carries } = slice;
    let { doc } = parent;
    // 1. THE SLICE IS OF THIS VERSION, asked before a row is written: its places are the
    // list's, its origin is where the runs before it end, and the runs it took the place of
    // are as long as the piece was when it was decoded.
    let row = this.#rows<VersionRow>(VERSION, doc, parent.id)[0];
    let [total] = this.#rows<{ runs: number; size: number }>(RUNS_TOTAL, parent.id);
    if (row === undefined || total.runs === 0) return undefined;
    let [sizes] = this.#rows<{ before: number; held: number }>(
      SLICE_SIZES, parent.id, slice.from, slice.to);
    let last = piece.content.at(-1);
    let length = last ? last.endIndex - piece.origin : 0;
    if (
      !(0 <= slice.from && slice.from <= slice.to && slice.to <= total.runs) ||
      piece.origin !== parent.bodyEndIndex - total.size + sizes.before ||
      sizes.held !== length - made.moved
    ) {
      throw new Error(
        "A slice does not fit the version it names: its places, its origin or its length " +
        "are not what the version's list of runs gives.");
    }
    // 2. THE CUT: the piece's elements, in hand, between the two boundaries the slice had.
    let cut: RunInHand[] = [];
    if (piece.content.length > 0) {
      for (let run of cutRuns(piece.content, this.#sizes, piece.footnotesBefore)) {
        runInHand(run.json);
        let id = runId(run.json);
        this.#putContent(doc, runNamed(piece.tabId, run.holds), id, run.json);
        cut.push({ id, size: run.size, elements: run.elements, holds: run.holds });
      }
    }
    // 3. THE CONTEXT: the parent's row, or the parent's with the lists the batch made.
    let contextKey = row.context;
    if (made.lists.length > 0) {
      let stored = this.#content(RUN_FOUND, RUN_JSON, row.context, doc);
      let context = stored && parsed(stored.text);
      if (!isRecord(context) || !isRecord(context.lists)) return undefined;
      let { lists } = context;
      for (let id of made.lists) lists[id] = piece.lists[id];
      let own = contextOf({
        lists: lists as GoogleDocsTab["lists"],
        namedStyles: context.namedStyles as GoogleDocsTab["namedStyles"],
      });
      this.#putContent(doc, listsNamed(piece.tabId), own.key, own.json);
      contextKey = own.key;
    }
    // 4. THE NAME, as the names pass: the parent's before the slice, the cut's, the parent's
    // after it.
    let meta: VersionMeta = {
      tabId: piece.tabId, bodyEndIndex: parent.bodyEndIndex + made.moved, exact: true,
    };
    let name = versionNamer(doc, meta, contextKey);
    let named = (from: number, to: number) => {
      for (let at = from; at < to; at += RUN_LIST_BATCH) {
        let page = this.#rows<{ run: string }>(RUN_NAMES, parent.id, at, to, RUN_LIST_BATCH);
        for (let { run } of page) name.add(run);
      }
    };
    named(0, slice.from);
    for (let { id } of cut) name.add(id);
    named(slice.to, total.runs);
    if (slice.from + cut.length + total.runs - slice.to === 0) {
      throw new Error("An edit would leave its tab a version that lists no run.");
    }
    let id = name.end();
    // 5. THE LIST AND THE RECORD, where the version is not keyed under the store's digest.
    let child = handle(doc, id, meta, parent);
    let stored = this.#rows<{ derived: string }>(VERSION_DERIVED, doc, id)[0];
    if (stored && derivedUnder(stored.derived, this.#made)?.keyed) return child;
    // The list another digest keyed is written over: its runs are these, its keys may not be.
    let list = this.#listWriter(doc, id, stored !== undefined);
    list.copy(parent.id, 0, slice.from);
    let state: Keying = { doc, carry: carries.ours, first: piece.origin, mover: carries };
    for (let run of cut) list.add(this.#keyInHand(piece, run, state));
    // THE WALK AFTER: the parent's later runs by place, a page at a time, while the carry is
    // not the parent's at the same place (the other side of `carries`, which stood after
    // the slice's last stored run and moves with the walk).
    let contexts = this.#contexts(doc, contextKey, parent.id);
    let next = this.#pages(parent, slice.to);
    for (let place = slice.to; place < total.runs; place++) {
      if (carries.same()) {
        list.copy(parent.id, place, total.runs);
        break;
      }
      let listed = next();
      if (!listed) return undefined;
      let { run, size } = listed;
      let summary = summaryOf(listed);
      let carry = summary && runCarryKey(summary, state.carry);
      if (summary) docStoreCost.runsKeyed++;
      if (summary && carry !== undefined && (carry === listed.carry || this.#rows(
        `SELECT 1 AS found ${MARKDOWN_KEY} AND made = ? ${IN_DOC}`,
        run, listed.context, carry, this.#made, doc,
      ).length > 0)) {
        list.add({ run, context: listed.context, carry, size });
        passed(state, summary, size);
      } else {
        // No rendering is stored under the key the run comes to: it is decoded where it
        // stands in this version and rendered with the lists its page names.
        let decoded = this.#decoded(
          parent, run, { first: state.first, footnotes: state.carry.footnoteBase }, true);
        let context = decoded && contexts(place, decoded.elements);
        if (!decoded || !context) return undefined;
        let rendered = renderedInHand(decoded.elements, context, state.carry);
        list.add(this.#keyRun(
          piece.tabId, { id: run, size, holds: heldBy(decoded.elements) }, context, state, rendered));
        summary = rendered.summary;
      }
      carries.advanceTheirs(summary);
    }
    list.end();
    this.#putRecord(doc, id, stored !== undefined, contextKey, meta, false);
    return child;
  }

  /**
   * What `edit` (a `docEditKey`) made in `version`, or `undefined` where nothing is stored for
   * it under the store's digest or the version it gave is gone. Reads one row, and the
   * child's small row. The version it gives carries `version`'s identity and write markers.
   */
  result(version: DocVersion, edit: string): StoredDocEditResult | undefined {
    let stored = this.#content<{ child: string | null }>(
      `SELECT child ${RESULT_KEY} AND made = ?`, `SELECT result ${RESULT_KEY} AND made = ?`,
      version.id, edit, this.#made,
    );
    let result = stored && parsed(stored.text);
    if (!stored || !isRecord(result)) return undefined;
    let found: StoredDocEditResult | undefined;
    if (isRecord(result.refusal)) {
      found = { refusal: result.refusal as DocRefusal };
    } else if (Array.isArray(result.requests) && stored.small.child !== null) {
      let { child } = stored.small;
      let after = child === version.id ? version : this.version(version.doc, child, version);
      found = after && { requests: result.requests as GoogleDocsRequest[], after };
    }
    if (found) docStoreCost.resultsFound++;
    return found;
  }

  /**
   * Stores what `edit` made in `version`, under the store's digest, in place of what another
   * digest stored for it. Written under the content it was computed from, so storing it
   * again changes nothing.
   * @throws `DocRowTooLargeError` for requests too large for a row.
   */
  putResult(version: DocVersion, edit: string, result: StoredDocEditResult): void {
    let stored = this.#rows<{ made: string }>(`SELECT made ${RESULT_KEY}`, version.id, edit)[0];
    if (stored?.made === this.#made) return;
    // The handle of the version the edit gives is not stored: its id is, in `child`.
    let child = "refusal" in result ? null : result.after.id;
    let json = JSON.stringify(
      "refusal" in result ? { refusal: result.refusal } : { requests: result.requests });
    requireRow(
      `The change an edit makes to tab "${version.tabId}" of this Google Doc`,
      version.id, edit, this.#made, child ?? "", json,
    );
    if (stored) {
      this.#rows(
        "UPDATE doc_result SET made = ?3, child = ?4, result = ?5 WHERE version = ?1 AND edit = ?2",
        version.id, edit, this.#made, child, json,
      );
    } else {
      this.#rows(
        "INSERT INTO doc_result (version, edit, made, child, result) VALUES (?, ?, ?, ?, ?)",
        version.id, edit, this.#made, child, json,
      );
    }
    docStoreCost.resultsStored++;
  }

  /**
   * `document` as this store is handed it: `fetchedDoc(document, fetchedAt, sizes)` with the
   * sizes this store cuts to. Reads and writes nothing.
   */
  fetched(document: GoogleDocsDocument, fetchedAt: number): FetchedDoc {
    return fetchedDoc(document, fetchedAt, this.#sizes);
  }

  // Stores each tab of `document` as a version of `doc` and answers the record that names the
  // copy (not stored: `keep` stores it, a `trial` does not). THE ONE STORING PASS over a
  // fetched document: `document.tabs` is read once, and for each tab each run, as it is cut or
  // read back, is counted in hand, named and checked against a row (`readTab`), its content
  // written, its key worked out beside the base version the stored copy lists for the same
  // tab (`#keying`: its rendering written where none is stored) and the run let go, before the
  // next element is read. Of the runs before it, a tab's names and list entries alone are in
  // hand, until the tab's end, when the version's id is known and its list is written or
  // dropped (`#putVersion`). Of the copy it replaces or stands beside this reads its record, a
  // version's record and its list a tab, small rows all, and no content. THE COPY'S BYTES
  // (`DocCopyHead.bytes`) are counted here, of each tab's context and of each run as it
  // passes, whether or not its row is already stored: a tab fetched unchanged counts as the
  // tab first stored, with no content read.
  #put(doc: string, document: FetchedDoc): DocCopyHead {
    let stored = this.head(doc);
    let inHand: InHand = { bytes: 0 };
    let bytes = 0;
    let outline: GoogleDocTabIdentity[] = [];
    let versions: string[] = [];
    let writeMarkers: DocWriteMarkerCopy[][] = [];
    for (let tab of document.tabs) {
      let { tabId } = tab.identity;
      let at = stored ? stored.outline.findIndex(listed => listed.tabId === tabId) : -1;
      let like = stored && at >= 0
        ? this.version(doc, stored.versions[at], { ...tab.identity, writeMarkers: tab.writeMarkers })
        : undefined;
      // Read once: a held tab parses its context at each read.
      let { context } = tab;
      let kept = contextOf(context);
      bytes += utf8Bytes(kept.json);
      let named: Named = { tabId, ...context };
      let state = keyingFrom(doc, tab.first);
      let key = this.#keying(named, kept.key, state, like);
      let entries: RunRow[] = [];
      let end = readTab(doc, tab, kept, inHand, (run, id) => {
        bytes += utf8Bytes(run.json);
        this.#putContent(doc, runNamed(tabId, run.holds), id, run.json);
        entries.push(key({ id, size: run.size, elements: run.elements, holds: run.holds }));
        inHandBy(inHand, -2 * run.json.length);
      });
      this.#putVersion(doc, kept, end, entries);
      outline.push(tab.identity);
      versions.push(end.id);
      writeMarkers.push(markersOf(tab.writeMarkers));
    }
    return {
      id: copyName(document.revision, versions, outline, writeMarkers),
      ...(document.revision === undefined ? {} : { revision: document.revision }),
      fetchedAt: document.fetchedAt,
      checkedAt: document.fetchedAt,
      stale: false,
      outline, versions, writeMarkers,
      made: this.#made,
      bytes,
    };
  }

  /**
   * Stores `document` as document `doc`'s copy, replacing the one stored: each tab as its
   * base version, the copy's record, checked at `document.fetchedAt` and not stale, and then
   * `sweep(doc, pending)`, in ONE transaction.
   *
   * THE DOCUMENT IS READ AS IT IS STORED. A run's rows are written when the run is cut: its
   * content, and its rendering where none is stored; the elements of a document of
   * `fetchedDoc` have left the parsed answer by then, and a held document (`heldDoc`) is
   * decoded a run at a time from its bytes. One run is in hand at a time. Everything is
   * inside the transaction, so a throw of the walk, of the cut, of a row too large or of the
   * renderer undoes every row, and the copy that was stored is as it was.
   *
   * A run, a context and a version already stored are not written again. A tab is keyed, as
   * its runs pass, beside the base version the stored copy lists for the same tab, whose
   * list is read a page of `RUN_LIST_BATCH` runs at a time, each run once (two rows a run:
   * the list's and the row of the rendering it names):
   * - A TAB FETCHED UNCHANGED renders nothing, keys nothing and writes nothing (one that
   *   came under another title, place or marker writes the copy's record alone): each run
   *   keeps the base's keys at its place, with one page of the base's list in hand.
   * - A TAB FETCHED CHANGED WRITES THE RUNS NEAR THE CHANGE, THEIR RENDERINGS, THE TAB'S LIST
   *   AND ITS RECORD, and renders only the runs with no rendering stored: from the first run
   *   that differs the tab is keyed by the walk beside the base (`#keyBeside`), against the
   *   base's list from that place on.
   * - A tab the stored copy does not hold has each of its runs rendered, alone, and stored;
   *   where its version is stored all the same (and keyed), the renderings are found and no
   *   row is written.
   * NO CONTENT OF THE COPY IT REPLACES IS READ (of it, the record, a version's record and
   * its list a tab), so a copy whose base has lost a run, a rendering or its context is
   * replaced all the same.
   *
   * WHAT IS IN HAND FOR EVERY RUN OF A TAB, beside the one run, until the tab's end:
   * - the runs' names and their list entries (a version's id is made of every run's name,
   *   so its list is written, or dropped for a version found keyed, when the last run is
   *   cut). As measured, bytes a run: about 200 for a tab of 1x1 tables each followed by an
   *   empty paragraph, 250 where each cell is an item of one list, 300 where each is an item
   *   of a list of its own (the carry keys are longer);
   * - from the first run that differs, the base's list from that place on (from the tab's
   *   first run where one of its lists is defined otherwise): of each run its carry key and
   *   a place, and each distinct summary once. As measured, bytes a run of the base: about
   *   300 for the tab of 1x1 tables and for the one whose cells are items of one list, and
   *   650 where each cell is an item of a list of its own, so that every summary differs.
   *   They are figures for those shapes, not a bound: a summary grows with the lists a run
   *   names and their levels.
   * Whether the model can follow a tab is asked of every element as it passes.
   * @param document A document read as it is stored (`fetched`), which is read once and
   * emptied, or a held one (`heldDoc`), whose runs are decoded here.
   * @param approved For a copy a scope check guards: the Drive folder the session stood on
   * whose approved read keeps the copy (left out where it stands on none) and the clock of
   * that approval, which the record keeps rounded down to `DOC_COPY_APPROVAL_GRAIN_MS`. Left
   * out for a bound Doc.
   * @throws `DocRowTooLargeError` for an element or a tab's lists too large for a row, checked
   * before the run is rendered; `DocRunRenderError` where the renderer throws on a run; and
   * what reading `document` throws (`fetchedDoc`: a `TypeError` for a tab or an element the
   * copy cannot keep, an `Error` for malformed named ranges). Nothing is stored then.
   */
  keep(
    doc: string, document: FetchedDoc, pending: DocPending,
    approved?: { readonly folder?: string; readonly at: number },
  ): DocCopyHead {
    return this.transaction(() => {
      let before = this.#rows<{ made: string }>("SELECT made FROM doc_copy WHERE doc = ?", doc)[0];
      let head: DocCopyHead = {
        ...this.#put(doc, document),
        ...(approved?.folder === undefined ? {} : { folder: approved.folder }),
        ...(approved === undefined ? {} : { approvedAt: approvalHour(approved.at) }),
      };
      // A document last swept under another digest stays marked so until the sweep below has
      // removed its renderings of that digest.
      this.#rows(
        `INSERT OR REPLACE INTO doc_copy (
          doc, id, revision, fetched_at, checked_at, stale, folder, approved, made, bytes,
          outline, markers, versions)
         VALUES (?1, ?2, ?3, ?4, ?4, 0, ?5, ?6, ?7, ?11, ?8, ?9, ?10)`,
        doc, head.id, head.revision ?? null, head.fetchedAt, head.folder ?? null,
        head.approvedAt ?? null, before?.made ?? this.#made,
        JSON.stringify(head.outline), JSON.stringify(head.writeMarkers), JSON.stringify(head.versions),
        head.bytes,
      );
      this.sweep(doc, pending);
      return head;
    });
  }

  /**
   * Runs `use` over `document` as document `doc`'s copy WITHOUT KEEPING IT, for a document just
   * fetched that the caller may not keep yet. In ONE transaction: each tab is stored as a version
   * of `doc` beside the stored copy's, as `keep` stores it (a tab the stored copy holds unchanged
   * IS that version, and nothing is written for it); `use` is given the record of the copy,
   * which is not stored (`head(doc)` still answers the copy stored before, or none); and then
   * `sweep(doc, pending())` removes every version neither the STORED copy nor a pending edit
   * reaches. So when the call returns or throws, storage holds of `doc` what it held before
   * and, of what `use` made, only this: in a tab the stored copy holds unchanged, the results
   * of the edits `pending()` names, the versions they give and the renderings of both; and
   * what `pending().roots` names with what the edits queued there made, which is made of
   * those edits' own text and of nothing fetched. The result of an edit `pending()` does not
   * name goes, in every tab: an edit `use` prepared is queued after the read is authorized, so
   * what a trial made of it is made once more by the read that follows. A document with no
   * stored copy and no root leaves no row. A Durable Object that stops in the middle has
   * committed nothing. The transaction is not rolled back for a throw of `use`: what `use`
   * wrote to the KV before it threw (a pending record marked) is committed with the sweep,
   * and the throw is rethrown after. `pending` is read after `use`, which may have marked
   * records. A promise `use` returns is refused as `transaction` refuses one: the trial checks
   * what `use` returned inside the transaction's callback, whose own value is not that promise.
   * A held document (`heldDoc`) can be tried more than once: each trial decodes its runs and
   * renders what the stored copy does not hold rendered.
   * @throws Before `use` is called, what `keep` throws for `document`; nothing of it is stored
   * then.
   */
  trial<T>(
    doc: string, document: FetchedDoc, pending: () => DocPending, use: (head: DocCopyHead) => T,
  ): T {
    let outcome = this.transaction(() => {
      let head = this.#put(doc, document);
      let used: { value: T } | { error: unknown };
      // A throw of `use` is not a rollback: the replay `use` runs marks pending records in the
      // KV, and those marks are its purpose. The rows it wrote are swept instead.
      try {
        used = { value: use(head) };
      } catch (error) {
        used = { error };
      }
      // The callback answers `used`, an object, so `transaction`'s own guard never sees what
      // `use` returned: a promise is refused here, inside the callback, which undoes the rows.
      if ("value" in used) requireSynchronous(used.value);
      this.sweep(doc, pending());
      return used;
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }

  /** The record of `doc`'s stored copy, of any age, stale or not; `undefined` for none. */
  head(doc: string): DocCopyHead | undefined {
    let row = this.#rows<CopyRow>(
      `SELECT id, revision, fetched_at, checked_at, stale, folder, approved, made, bytes,
        outline, markers, versions
       FROM doc_copy WHERE doc = ?`,
      doc,
    )[0];
    if (row === undefined) return undefined;
    let outline = parsed(row.outline), versions = parsed(row.versions), markers = parsed(row.markers);
    // A record that is not what was stored names no copy: the next keep replaces it.
    if (!Array.isArray(outline) || !Array.isArray(versions) || !Array.isArray(markers) ||
      outline.length !== versions.length || markers.length !== outline.length ||
      !outline.every(tab => isRecord(tab) && typeof tab.tabId === "string") ||
      !versions.every(version => typeof version === "string") ||
      !markers.every(tab => Array.isArray(tab))) {
      return undefined;
    }
    return {
      id: row.id,
      ...(row.revision === null ? {} : { revision: row.revision }),
      fetchedAt: row.fetched_at,
      ...(row.checked_at === null ? {} : { checkedAt: row.checked_at }),
      stale: row.stale !== 0,
      outline, versions, writeMarkers: markers,
      ...(row.folder === null ? {} : { folder: row.folder }),
      ...(row.approved === null ? {} : { approvedAt: row.approved }),
      made: row.made,
      bytes: row.bytes,
    };
  }

  /**
   * Changes when `doc`'s copy was last confirmed (`checkedAt`: a clock, or `null` for "due a
   * check"), marks it `stale`, or records that a scope check just `approved` a read of it:
   * the folder that read stood on (left out for none) and the clock, kept rounded down to
   * `DOC_COPY_APPROVAL_GRAIN_MS`. Does nothing where no copy is stored, and writes no row
   * where the record already says so: reads of one copy approved under one folder within one
   * grain write its record once.
   */
  touch(
    doc: string,
    change: { checkedAt: number | null } | { stale: true }
      | { approved: { readonly folder?: string; readonly at: number } },
  ): void {
    // `IS NOT` compares NULL too, so each statement leaves alone a record that says so already.
    if ("checkedAt" in change) {
      this.#rows(
        "UPDATE doc_copy SET checked_at = ?2 WHERE doc = ?1 AND checked_at IS NOT ?2",
        doc, change.checkedAt,
      );
    } else if ("stale" in change) {
      this.#rows("UPDATE doc_copy SET stale = 1 WHERE doc = ? AND stale = 0", doc);
    } else {
      this.#rows(
        `UPDATE doc_copy SET folder = ?2, approved = ?3
         WHERE doc = ?1 AND (folder IS NOT ?2 OR approved IS NOT ?3)`,
        doc, change.approved.folder ?? null, approvalHour(change.approved.at),
      );
    }
  }

  /**
   * The small record of every copy the store holds, in no stated order: one statement over
   * `doc_copy` that names its small columns alone, so a row a copy is read and no outline,
   * marker or version list, and no other table. What is in hand is a record a copy.
   */
  copies(): DocCopyRecord[] {
    return this.#rows<{ doc: string; approved: number | null; fetched_at: number; bytes: number }>(
      "SELECT doc, approved, fetched_at, bytes FROM doc_copy",
    ).map(({ doc, approved, fetched_at: fetchedAt, bytes }) => ({
      doc, ...(approved === null ? {} : { approvedAt: approved }), fetchedAt, bytes,
    }));
  }

  /** Whether `doc`'s stored copy is the one named `id`, and no write was noted since. */
  holds(doc: string, id: string): boolean {
    return this.#rows(
      "SELECT 1 AS found FROM doc_copy WHERE doc = ? AND id = ? AND stale = 0", doc, id,
    ).length > 0;
  }

  /**
   * Removes `doc`'s copy and everything stored for it, in one transaction, BY THE DOCUMENT'S
   * KEY: its versions' results and run lists (searched by each version's key), its versions,
   * its renderings, its runs and contexts, and its record. No list and no content reaches the
   * isolate, and no statement names another document: what it costs is a row written for
   * each row the document held. Where the storage holds other documents it is billed up to
   * six rows read more, the same for a thousand of them as for two hundred. Nothing of the
   * document is left, under any digest.
   */
  drop(doc: string): void {
    this.transaction(() => {
      this.#dropRows(doc);
      this.#rows("DELETE FROM doc_copy WHERE doc = ?", doc);
    });
  }

  // Removes every row `doc` holds but its copy's record, by the document's key: the results
  // and the run lists of its versions while their records still name them, then the records,
  // the renderings, and the runs and contexts. Each is a search of one range of a key.
  #dropRows(doc: string): void {
    this.#rows(
      "DELETE FROM doc_result WHERE version IN (SELECT id FROM doc_version WHERE doc = ?)", doc);
    this.#rows(
      "DELETE FROM doc_seq WHERE version IN (SELECT id FROM doc_version WHERE doc = ?)", doc);
    this.#rows("DELETE FROM doc_version WHERE doc = ?", doc);
    this.#rows("DELETE FROM doc_md WHERE doc = ?", doc);
    this.#rows("DELETE FROM doc_run WHERE doc = ?", doc);
  }

  /**
   * Removes what nothing reaches of `doc`. LIVE are the base versions of its stored copy, the
   * versions `pending.roots` names, and every version a chain of results of the edits
   * `pending.edits` names, STORED UNDER THE STORE'S DIGEST, leads to from one of those.
   * Everything else of `doc` goes: each other version with its run list and its results, each
   * result of a live version whose edit is not pending or that was made under another digest,
   * and each run, context and rendering of the document that no version left lists. Where
   * the copy's record says the document was last swept under another digest, the document's
   * renderings made under another digest go too, and the record then says the store's.
   *
   * EVERY STATEMENT OF IT NAMES `doc` OR A VERSION OF `doc`, NONE WRITES A ROW OF ANOTHER
   * DOCUMENT, AND IT BRINGS NO LIST TO THE ISOLATE. Content is a document's own (`doc_run` and
   * `doc_md` are keyed by document), so what a dead version alone listed is found among this
   * document's lists. The live versions are found first, from small rows taken whole (the walk
   * keeps a set, so two edits that undo each other end it). Then, while the dead versions' lists
   * still say what they named, one `DELETE` removes the renderings and one the runs that a dead
   * version lists and no live version does: each compares the lists inside storage, as the set
   * of what the dead name and the set of what the live name (one entry a distinct name, in
   * storage's own memory), so what is in hand is the two lists of version ids, however many runs
   * the tab has. A third removes the contexts only dead versions name. Then the dead versions'
   * results, lists and records go, by key. Where no version of the document is live (a trial of
   * a document with no stored copy and no root), everything the document holds is removed by its
   * range of each key, and no list is read.
   * WHAT IT COSTS IS COUNTED IN THE DOCUMENT'S OWN RUNS: two rows read for each run of each dead
   * and each live version's list (the lists are read once for the renderings and once for the
   * runs), a content row searched for each distinct name of the dead lists, and a row written
   * for each row removed. What the storage holds of other documents adds no row written and, as
   * storage bills it, up to six rows read, the same for a thousand documents as for two hundred.
   * Storage bills the steps of its sets too: on a tab of 19,601 runs the sweep after a rejection
   * is billed 8.5 rows read a run. A list is a row a run, and a tab is about one run for each
   * 32 KiB of consecutive paragraphs and, beside those, one for every table and one for every
   * stretch of paragraphs between two tables: some hundreds for a long tab of prose, thousands
   * for a tab of many tables. Order: renderings, runs, contexts, results, run lists, versions.
   * Call it in the transaction that removes a pending record (an approval's handoff, a
   * rejection), so nothing that removal orphans outlives it; an orphan a failed request left is
   * found the same way, since nothing but storage names a version.
   */
  sweep(doc: string, pending: DocPending): void {
    // The order: content goes first, while the dead versions' run lists still say which
    // content they named, and only where no live version's list names it; then a dead
    // version's own rows, by key. Nothing but storage names a version, so one a failed request
    // left behind is dead here like any other.
    this.transaction(() => {
      let head = this.head(doc);
      let edits = new Set(pending.edits);
      let live = new Set(head?.versions);
      for (let root of pending.roots) {
        if (this.#rows(VERSION, doc, root).length > 0) live.add(root);
      }
      // The live versions that hold a result nothing serves: of an edit that is not pending, or
      // made under another digest.
      let noted: string[] = [];
      for (let version of live) {
        let results = this.#rows<{ edit: string; made: string; child: string | null }>(
          "SELECT edit, made, child FROM doc_result WHERE version = ?", version);
        let unserved = false;
        for (let { edit, made, child } of results) {
          if (made !== this.#made || !edits.has(edit)) unserved = true;
          // A set visits what is added to it while it is walked, each member once.
          else if (child !== null) live.add(child);
        }
        if (unserved) noted.push(version);
      }
      let alive = JSON.stringify([...live]);
      let dead = this.#rows<{ id: string }>(
        `SELECT id FROM doc_version
         WHERE doc = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`,
        doc, alive,
      );
      let otherDigest = head !== undefined && head.made !== this.#made;
      if (dead.length === 0 && noted.length === 0 && !otherDigest) return;

      for (let version of noted) {
        this.#rows(
          `DELETE FROM doc_result
           WHERE version = ?1 AND (made <> ?3 OR edit NOT IN (SELECT value FROM json_each(?2)))`,
          version, JSON.stringify(pending.edits), this.#made,
        );
      }
      if (live.size === 0) {
        // No version is live, so nothing of the document's content is: no list is compared.
        if (dead.length > 0) this.#dropRows(doc);
      } else if (dead.length > 0) {
        let ids = JSON.stringify(dead.map(({ id }) => id));
        this.#rows(RENDERINGS_OF_DEAD, doc, ids, alive);
        this.#rows(RUNS_OF_DEAD, doc, ids, alive);
        this.#rows(CONTEXTS_OF_DEAD, doc, ids, alive);
        this.#rows("DELETE FROM doc_result WHERE version IN (SELECT value FROM json_each(?1))", ids);
        this.#rows("DELETE FROM doc_seq WHERE version IN (SELECT value FROM json_each(?1))", ids);
        this.#rows(
          "DELETE FROM doc_version WHERE doc = ?1 AND id IN (SELECT value FROM json_each(?2))", doc, ids);
      }
      if (otherDigest) {
        // The first sweep of a document under a digest: the renderings other code made for it
        // go, by the document's range of their key, and the record says so. Whether the model
        // indexes a live tab (`doc_version.derived`) is left as it is: it is read only under
        // its own digest, and working it out needs the tab decoded.
        this.#rows("DELETE FROM doc_md WHERE doc = ?1 AND made <> ?2", doc, this.#made);
        this.#rows("UPDATE doc_copy SET made = ?2 WHERE doc = ?1", doc, this.#made);
      }
    });
  }
}
