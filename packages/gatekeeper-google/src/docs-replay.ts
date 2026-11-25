// Pending edits to a Google Doc, replayed on the gatekeeper's copy of it: the one place an edit
// becomes `documents.batchUpdate` requests, for approval and for replay alike, the edit made in
// a version by the model of Google Docs, which is handed the runs the batch touches and never
// the tab whole, and the reducer that folds one tab's edits over that tab's version in the
// store (`./docs-store`).
// Nothing here remembers anything: no tab, no rendering, no result of an edit. What is kept is
// kept by the store, which `docEditResult` and the reducer read and write; everything else is a
// pure function of what is in hand, but for the counts of what it spends (`replayCost`), and
// nothing logs or changes a tab it was given.

import type { EntityStep, SimulationStoreOptions } from "@gadgets/gatekeeper-kit/simulation-store";
import type { GoogleDocsRequest, GoogleDocsTab } from "./docs-api";
import {
  applyDocsRequests, applyDocsRequestsToSlice, batchReach, namedBy, NotModelledError, replayCost,
  SliceEdgeError, unindexedTabRefusal, type SliceResult,
} from "./docs-model";
import { isDocCopyUnreadable } from "./docs-replica";
import {
  DocReadingFault, storedTabReading, unwrapped, type StoredTabReading,
} from "./docs-reading";
import {
  DOC_ROW_BYTES, DocPieceError, DocRowTooLargeError, DocRunRenderError, runId, tabRendered,
  type DocPiece, type DocSlice, type DocStore, type DocVersion, type RunPlaces,
} from "./docs-store";
import {
  closesTableGate, commonPrefix, commonSuffix, namesTable, refuseSuggestionsTouched,
  tableGateRefusal, tabOf, tabTableChangeRequests, textReplacementRequests, type TableChange,
} from "./docs-tables";
import {
  docTabToMarkdown, isBlankDocTab, lineStart, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
  refuseNewSuggestionMarks, REPLAYABLE_TEXT_EDIT_VERSIONS, type DocTabPart, type DocTabSnapshot,
  type TabReading,
} from "./markdown-converter";

export { isBlankDocTab };

/** An edit to one tab, as it is stored with its pending action and as approval sends it. */
export type DocEdit =
  | {
    type: "replaceText";
    oldMarkdown: string;
    newMarkdown: string;
    /**
     * Set when the replacement was queued as a change to the text of table cells. Such an edit
     * applies only while its text is still in a table; any other applies outside tables.
     */
    inTable?: true;
  }
  | { type: "appendText"; markdown: string }
  | TableChange;

/** What replay reads of a stored action beside its edit. */
export type QueuedDocEdit = DocEdit & {
  /** The tab the edit targets. Absent only on records stored before tabs could be named. */
  tabId?: string;
  /** Why the edit no longer applies, once something found that it does not. */
  invalidatedReason?: string;
  /** The Markdown version the edit was previewed under. */
  markdownVersion?: number;
  /** Names the write, and its marker in the document once it is sent. */
  writeId?: string;
};

/** One pending action of a document, as the journal lists it. */
export type QueuedDocRecord = { readonly id: number; readonly action: QueuedDocEdit };

// ---------------------------------------------------------------------------
// The tab an edit targets
// ---------------------------------------------------------------------------

/**
 * The tab an operation names among `tabs`, or a refusal telling the agent how to name one;
 * `operation` is the session method, as the refusal names it. Omission is resolved from the
 * flattened tab list, so a single root with any child counts as multi-tab. An unknown id never
 * falls back to the first tab: the caller meant a specific one.
 */
export function resolveDocTab<T extends { tabId: string }>(
  tabs: readonly T[], tabId: string | undefined, operation: string,
): T {
  if (tabId === undefined) {
    if (tabs.length !== 1) {
      throw new Error(
        `${operation}: tabId is required for documents with multiple tabs. ` +
        `Call listTabs() to choose a tab.`);
    }
    return tabs[0];
  }
  let tab = tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(
      `${operation}: no tab with ID "${tabId}" exists in this document. ` +
      `Call listTabs() to refresh the tab list.`);
  }
  return tab;
}

/**
 * The tab a stored edit targets. A record stored before tabs could be named names none; it was
 * approved against a document of one tab, so it resolves while the document still has one, and
 * is refused once it has more.
 */
export function docEditTab<T extends { tabId: string }>(tabs: readonly T[], action: QueuedDocEdit): T {
  if (action.tabId === undefined && tabs.length !== 1) {
    throw new Error(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  }
  return resolveDocTab(tabs, action.tabId, action.type);
}

/**
 * Throws for a stored edit that no longer replays: with its stored reason when it has one, and
 * otherwise unless it was previewed under the current Markdown version, or is a text edit (a
 * replacement outside tables, an append) previewed under an earlier version that reads the same
 * outside tables (`REPLAYABLE_TEXT_EDIT_VERSIONS`).
 */
export function assertDocEditReplayable(action: QueuedDocEdit): void {
  if (action.invalidatedReason) throw new Error(action.invalidatedReason);
  let { markdownVersion } = action;
  if (markdownVersion === MARKDOWN_RENDERING_VERSION) return;
  let textEdit = action.type === "replaceText" || action.type === "appendText";
  if (!textEdit || markdownVersion === undefined ||
      !REPLAYABLE_TEXT_EDIT_VERSIONS.includes(markdownVersion)) {
    throw new Error(
      "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
      "apply as previewed. Reject it and retry.");
  }
}

/**
 * The Markdown rendering of a tab in hand, whole. Counts a render (`replayCost.renders`), the
 * tab's runs rendered and its Markdown in hand (`tabRendered`). Part of the edit on a tab in
 * hand that the store's path is held to: nothing that reads or edits a document calls it.
 */
export function renderTab(tab: GoogleDocsTab): DocTabSnapshot {
  replayCost.renders++;
  let rendering = docTabToMarkdown(tab);
  tabRendered(tab, rendering);
  return rendering;
}

// ---------------------------------------------------------------------------
// An edit as requests
// ---------------------------------------------------------------------------

// The one place a replacement's text stands in tab `tabId`, from what a search of the tab's
// Markdown answered (`find`, asked only of a text that is not empty), or the refusal of a
// replacement whose text is empty, is not there, or is there more than once.
function uniquePlace(
  oldMarkdown: string, tabId: string, find: () => number | "none" | "many",
): number {
  if (oldMarkdown.length === 0) {
    throw new Error("replaceText: oldMarkdown must not be empty.");
  }
  let found = find();
  if (found === "none") {
    throw new Error(
      `replaceText: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
      `Make sure the text exactly matches content returned by getContent("${tabId}").`);
  }
  if (found === "many") {
    throw new Error(
      `replaceText: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${tabId}". Include more surrounding context to make the match unique.`);
  }
  return found;
}

/**
 * The start of the one place `oldMarkdown` stands in `markdown`. Throws the refusal of a
 * replacement whose text is empty, is not there, or is there more than once.
 */
export function findUniqueMarkdown(markdown: string, oldMarkdown: string, tabId: string): number {
  return uniquePlace(oldMarkdown, tabId, () => {
    let index = markdown.indexOf(oldMarkdown);
    if (index === -1) return "none";
    return markdown.indexOf(oldMarkdown, index + 1) === -1 ? index : "many";
  });
}

/**
 * The start of the one place `oldMarkdown` stands in the tab `tab` reads (`TabReading.find`).
 * Throws the refusal of a replacement whose text is empty, is not there, or is there more
 * than once.
 */
export function uniqueMarkdown(tab: TabReading, oldMarkdown: string): number {
  return uniquePlace(oldMarkdown, tab.tabId, () => tab.find(oldMarkdown));
}

/**
 * The side on which `requests`, built from a piece that stands at `part`, name an index
 * past the piece's inner range where the tab goes on; `undefined` where they name none.
 * BEFORE is exact: the lowest index a batch names is in the tab's own coordinates
 * (`batchReach`). AFTER is a lower bound: each index is counted where it stood at least,
 * which is itself less the characters the batch's `insertText` requests before it carry,
 * and no index is counted from the first request that can add length otherwise (a table, a
 * row or a column inserted, cells merged). So a batch it passes may still write past the
 * piece after text it inserted; one it names a side for does. A batch that names no index
 * (no request, or none of a kind that names one: `batchReach` answers `undefined`) names
 * no side.
 */
export function pieceOverreach(
  requests: readonly GoogleDocsRequest[], part: Pick<DocTabPart, "first" | "last" | "inner">,
): "before" | "after" | undefined {
  let reach = batchReach(requests);
  if (!reach) return undefined;
  if (!part.first && reach.from < part.inner.from) return "before";
  if (part.last) return undefined;
  // An index a request names stood, in the tab as the piece renders it, no lower than the
  // index less what the requests before it added. Of the kinds the model takes to change a
  // length (`batchReach`), five are counted past. `insertText` adds its text's length at
  // most (Google removes characters from inserted text, never adds one), so the text as the
  // request writes it is taken off every index after it. `deleteContentRange` removes its
  // range; `createParagraphBullets` takes leading tabs off the paragraphs it bullets;
  // `deleteTableRow` and `deleteTableColumn` remove cells: each only shortens what follows
  // it, so an index after it stood higher, and is counted as written. Any other kind that
  // changes a length may add some no request states, and ends the count.
  let inserted = 0;
  for (let request of requests) {
    let named = namedBy(request);
    if (!named) continue;
    if (named.high - inserted > part.inner.to) return "after";
    if ("insertText" in request) inserted += request.insertText.text.length;
    else if (named.lengthens && !("deleteContentRange" in request ||
        "createParagraphBullets" in request || "deleteTableRow" in request ||
        "deleteTableColumn" in request)) break;
  }
  return undefined;
}

/**
 * What `tabEditRequests` throws, as the `cause` of a `DocModelError`, for a batch that
 * names an index past the piece it was built from (`pieceOverreach`): the piece did not
 * hold what the edit reads, so the batch is not the whole tab's and is never sent. Its
 * message is fixed and quotes nothing.
 */
export class DocPieceOverreachError extends Error {
  /** The side of the piece the batch reaches past. */
  readonly side: "before" | "after";

  constructor(side: "before" | "after") {
    super("A batch reaches past the piece it was built from.");
    this.name = "DocPieceOverreachError";
    this.side = side;
  }
}

/**
 * The `documents.batchUpdate` requests that make `edit` in the tab `tab` reads: the one
 * place an edit becomes requests. The edit's own elements are found in the tab as a whole
 * (the text replaced, by its one place; an append, at the tab's end; a table, by how it
 * reads), the piece around them is asked of the reading, and the builders build from that
 * piece. Approval sends the requests and replay applies them to the copy, so a read of
 * a pending edit and its approval come from the same requests. An edit that changes nothing
 * gives none.
 * @throws The refusal of an edit the tab does not take, in the words the caller reads, which
 * a batch that names an index past the piece it was built from is too (`pieceOverreach`): a
 * `DocModelError` worded as a change that cannot be shown, whose `cause` is a
 * `DocPieceOverreachError`. A piece that cannot be made (`DocPieceError`) is refused in the
 * same words, with that error as the `cause`. A `DocReadingFault` where a stored reading
 * could not be read.
 */
export function tabEditRequests(tab: TabReading, edit: DocEdit): GoogleDocsRequest[] {
  let piece: DocTabSnapshot;
  let requests: GoogleDocsRequest[];
  try {
    switch (edit.type) {
      case "replaceText": {
        let { oldMarkdown, newMarkdown, inTable } = edit;
        // A cell's text marks a suggestion in HTML, which its own reading refuses to write.
        if (!inTable) refuseNewSuggestionMarks(edit.type, oldMarkdown, newMarkdown);
        let at = uniqueMarkdown(tab, oldMarkdown);
        piece = tab.piece({ markdown: { mdStart: at, mdEnd: at + oldMarkdown.length } });
        // The piece's Markdown starts where its part says: the one place the tab's offset
        // becomes the piece's.
        let matchStart = at - (piece.part?.mdStart ?? 0);
        requests = textReplacementRequests(
          piece, { matchStart, oldMarkdown, newMarkdown, ...(inTable ? { inTable } : {}) });
        break;
      }
      case "appendText": {
        refuseNewSuggestionMarks(edit.type, "", edit.markdown);
        piece = tab.piece("end");
        if (piece.sourceMap.blocks.at(-1)?.docEnd !== piece.bodyEndIndex) {
          throw new Error(
            "appendText: the selected tab does not end in a paragraph. " +
            "Add a paragraph after its final table or structural element and retry.");
        }
        let index = piece.bodyEndIndex - 1;
        // Blankness is the tab's: a piece at the end of a tab that ends in an empty paragraph
        // renders as a line break alone.
        requests = tab.blank()
          ? markdownToDocRequests(edit.markdown, index, tab.tabId, { resetParagraphs: true })
          : markdownToDocRequests("\n" + edit.markdown, index, tab.tabId, {
            resetParagraphs: true, preserveLeadingParagraph: true,
            tabBlocks: piece.sourceMap.blocks,
          });
        break;
      }
      default:
        ({ requests, piece } = tabTableChangeRequests(tab, edit));
    }
  } catch (error) {
    // A piece that cannot be made is a function of the tab and the edit: the edit's refusal.
    if (error instanceof DocPieceError) throw new DocModelError(modelRefusal(edit.type, error), error);
    throw error;
  }
  let side = piece.part && pieceOverreach(requests, piece.part);
  if (side) {
    let cause = new DocPieceOverreachError(side);
    throw new DocModelError(modelRefusal(edit.type, cause), cause);
  }
  // A table change is checked for the suggestions its table holds as it is built.
  if (edit.type === "replaceText" || edit.type === "appendText") {
    refuseSuggestionsTouched(piece, requests, edit.type);
  }
  return requests;
}

/**
 * `tabEditRequests` for the tab `render` renders: of the reading a part was cut for, or of
 * the whole rendering's own (`tabOf`).
 */
export function docEditRequests(render: DocTabSnapshot, edit: DocEdit): GoogleDocsRequest[] {
  return tabEditRequests(tabOf(render), edit);
}

/**
 * The stored edit `action` against the document's tabs as fetched: the tab it targets, rendered,
 * and the requests approval sends. Throws what replay refuses the edit with: its stored reason,
 * an earlier Markdown version that no longer replays, a tab that is gone, or a builder's refusal.
 * The build of a write from tabs in hand that the store's path is held to: nothing that reads
 * or edits a document calls it.
 */
export function materializeDocEdit(
  tabs: readonly GoogleDocsTab[], action: QueuedDocEdit,
): { tab: DocTabSnapshot; requests: GoogleDocsRequest[] } {
  assertDocEditReplayable(action);
  let tab = renderTab(docEditTab(tabs, action));
  return { tab, requests: docEditRequests(tab, action) };
}

// ---------------------------------------------------------------------------
// An edit made in a tab
// ---------------------------------------------------------------------------

/**
 * Thrown by `applyDocRequests` where the model of Google Docs did not apply a batch. The message
 * is the refusal the caller reads; `cause` is what the model threw.
 */
export class DocModelError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "DocModelError";
  }
}

const NOT_SHOWN_TAIL = "so it cannot be made through this connection. Make it in Google Docs.";

/** The refusal of the batch `operation` made, worded by what the model threw for it. */
function modelRefusal(operation: string, thrown: unknown): string {
  if (thrown instanceof NotModelledError) {
    return `${operation}: this change cannot be shown as it will read once applied ` +
      `(${thrown.what}), ${NOT_SHOWN_TAIL}`;
  }
  // The model throws a plain `Error`, in Google's words, where Google would refuse the batch.
  if (thrown instanceof Error && Object.getPrototypeOf(thrown) === Error.prototype) {
    return `${operation}: Google Docs would refuse this change: ${thrown.message}`;
  }
  // A fault of the model: what it threw is internal and may quote the document.
  return `${operation}: this change cannot be shown as it will read once applied, ${NOT_SHOWN_TAIL}`;
}

/**
 * `tab` with `requests`, the batch of an edit `operation` made, applied as Google Docs applies
 * them (`applyDocsRequests`); `tab` itself when there are none. Throws a `DocModelError`, worded
 * for `operation`: in Google's words where Google would refuse the batch, and without what the
 * model threw where the model has no answer or is at fault. The model's part of the edit on a
 * tab in hand that the store's path is held to (`editedSlice` is what an edit of a stored
 * version calls): nothing that reads or edits a document calls it.
 */
export function applyDocRequests(
  tab: GoogleDocsTab, operation: string, requests: readonly GoogleDocsRequest[],
): GoogleDocsTab {
  if (requests.length === 0) return tab;
  try {
    return applyDocsRequests(tab, requests);
  } catch (thrown) {
    throw new DocModelError(modelRefusal(operation, thrown), thrown);
  }
}

/** An edit made in a tab: the requests that make it, and the tab with them applied. */
export type MadeDocEdit = {
  readonly requests: readonly GoogleDocsRequest[];
  /** The tab given, itself, for an edit that changes nothing. */
  readonly after: GoogleDocsTab;
};

/** The keys of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Every field a `DocEdit` may carry: what `docEditRequests` builds an edit's requests from. */
const DOC_EDIT_FIELDS: Record<KeysOfUnion<DocEdit>, true> = {
  type: true, oldMarkdown: true, newMarkdown: true, inTable: true, markdown: true, rows: true,
  columns: true, cells: true, after: true, at: true, count: true, expected: true, unshown: true, copies: true, pinned: true,
  suggested: true, style: true, row: true, column: true, width: true, height: true,
};

/** `value` with the keys of every object in it sorted. Arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  let fields = value as Record<string, unknown>;
  let sorted: Record<string, unknown> = {};
  for (let key of Object.keys(fields).toSorted()) sorted[key] = canonical(fields[key]);
  return sorted;
}

/**
 * The name of `edit` among the stored results: `runId` of the JSON of its `DocEdit` fields
 * (`DOC_EDIT_FIELDS`, in that table's order, a field the edit does not carry left out), which
 * is everything `docEditRequests` reads of an edit and nothing a stored record gains later (a
 * write id, a reason, a display). Each field's value is written with the keys of every object
 * in it sorted, so two records that hold the same fields have the same key however each was
 * built.
 */
export function docEditKey(edit: DocEdit): string {
  let fields: Partial<Record<string, unknown>> = edit;
  let pairs: [string, unknown][] = [];
  for (let name of Object.keys(DOC_EDIT_FIELDS)) {
    if (fields[name] !== undefined) pairs.push([name, canonical(fields[name])]);
  }
  return runId(JSON.stringify(pairs));
}

/**
 * `edit` made in `tab`, a tab in hand: `docEditRequests` on its rendering, applied by
 * `applyDocRequests`. Nothing is stored and nothing is remembered: asked again, it makes the
 * edit again. `after` is `tab` itself for an edit that changes nothing. The edit on a tab in
 * hand that the store's path (`docEditResult`) is held to: nothing that reads or edits a
 * document calls it.
 * @param rendering `renderTab(tab)`, where the caller has it in hand.
 */
export function makeDocEdit(
  tab: GoogleDocsTab, edit: DocEdit, rendering: DocTabSnapshot = renderTab(tab),
): MadeDocEdit {
  let requests = docEditRequests(rendering, edit);
  return { requests, after: applyDocRequests(tab, edit.type, requests) };
}

/**
 * `tab` with `edit` made in it: `makeDocEdit(tab, edit).after`. The edit on a tab in hand that
 * the store's path is held to: nothing that reads or edits a document calls it.
 */
export function applyDocEdit(tab: GoogleDocsTab, edit: DocEdit): GoogleDocsTab {
  return makeDocEdit(tab, edit).after;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Why replay refused an edit. At most one of `unindexed`, `unmodelled`, `modelError` and
 * `overreach` is set.
 */
export type DocRefusal = {
  /** The refusal, in the words the caller reads, without who asked for the replay. */
  readonly reason: string;
  /** Set when the edit's tab is one the copy cannot index. */
  readonly unindexed?: true;
  /**
   * Set when the model had no answer: the shape it names, which never holds document text, and
   * whether nothing the builders send should reach that shape.
   */
  readonly unmodelled?: { readonly what: string; readonly invariant: boolean };
  /**
   * Set when the model threw anything else. `name` is the name of the error's class: `"Error"`
   * is a batch Google Docs would refuse, which is a fault of the builder that sent it; any other
   * name is a fault of the model. `frames` is where it was thrown: the frames of the error's
   * stack without the line or lines of its message, which may quote the document; absent where
   * what was thrown has no stack.
   */
  readonly modelError?: { readonly name: string; readonly frames?: string };
  /**
   * Set when the batch built from a piece of the tab names an index outside the piece, on
   * the side given, where the tab goes on: the piece did not hold what the edit reads.
   */
  readonly overreach?: "before" | "after";
  /** Set when the refused edit closes its tab's table gate (`closesTableGate`, on a named tab). */
  readonly closesGate?: true;
};

/**
 * Thrown for an edit a version does not take, with the refusal as it is stored and logged.
 * Its message is `refusal.reason`. Its `name` is `"DocModelError"` for a refusal by the model
 * (one that carries `unmodelled` or `modelError`) and for a batch past its piece (`overreach`),
 * which is thrown as one, and `"Error"` for any other, which are the
 * names of what the model's wrapper and the builders throw: the name crosses RPC, so a
 * refusal reads the same to a caller whether it was just made or found stored.
 */
export class DocEditRefusedError extends Error {
  readonly refusal: DocRefusal;

  constructor(refusal: DocRefusal) {
    super(refusal.reason);
    if (refusal.unmodelled || refusal.modelError || refusal.overreach) this.name = "DocModelError";
    this.refusal = refusal;
  }
}

/**
 * Where `thrown` was thrown: the frames of its stack. The engine writes a stack as the error's
 * own line, then the frames, so that line is taken off the head and only the trailing run of
 * frames is kept: a message that spans lines, or was changed after the throw, stays out.
 */
function thrownAt(thrown: unknown): string | undefined {
  if (!(thrown instanceof Error) || typeof thrown.stack !== "string") return undefined;
  let head = String(thrown);
  let lines = (thrown.stack.startsWith(head) ? thrown.stack.slice(head.length) : thrown.stack)
    .split("\n");
  let first = lines.length;
  while (first > 0 && /^\s+at /.test(lines[first - 1])) first--;
  return first === lines.length ? undefined : lines.slice(first).join("\n");
}

/**
 * The refusal an error thrown while an edit was made or replayed stands for: the refusal a
 * `DocEditRefusedError` carries; otherwise its message, and, for a `DocModelError`, the side
 * on which the batch left its piece (`DocPieceOverreachError`) or what the model did. Any
 * other error is a builder's refusal or the gate's, and gives the reason alone.
 */
export function docRefusal(error: unknown): DocRefusal {
  if (error instanceof DocEditRefusedError) return error.refusal;
  let reason = error instanceof Error ? error.message : String(error);
  if (!(error instanceof DocModelError)) return { reason };
  let { cause } = error;
  if (cause instanceof DocPieceOverreachError) return { reason, overreach: cause.side };
  if (cause instanceof NotModelledError) {
    return { reason, unmodelled: { what: cause.what, invariant: cause.invariant } };
  }
  let frames = thrownAt(cause);
  return {
    reason,
    modelError: {
      name: cause instanceof Error ? cause.name : typeof cause,
      ...(frames === undefined ? {} : { frames }),
    },
  };
}

/** What `docEditResult` answers. */
export type DocEditResult = {
  readonly requests: readonly GoogleDocsRequest[];
  /** The version the requests give: the version itself for an edit that changes nothing. */
  readonly after: DocVersion;
};

/**
 * The refusal of an edit whose result passes one stored row: an element of the tab as the edit
 * would leave it, or the requests that make it. Every element of the tab in Google is under
 * the limit, since the version the edit is made in is stored, so the reader is told that the
 * edit is too large.
 */
function editTooLargeRefusal(edit: DocEdit, tabId: string, error: DocRowTooLargeError): string {
  return `${edit.type}: this edit is too large for tab "${tabId}" of this Google Doc: a ` +
    `paragraph or a table of the tab as the edit would leave it, or the change itself, takes ` +
    `${error.bytes} bytes as stored, and one stored row holds ${DOC_ROW_BYTES}. Make a smaller ` +
    `change, or make that paragraph or table smaller in Google Docs first.`;
}

// One attempt, in a frame of its own: the slice `make` answers, handed to the model. Answers
// what the model made of it, or, where the model read past an edge, the edge and the places
// the slice held and NOTHING OF THE SLICE, which is unreachable once this returns. `make` is
// called outside any `try`: what it throws passes.
function attempt(
  make: () => DocSlice, operation: string, requests: readonly GoogleDocsRequest[],
): { slice: DocSlice; made: SliceResult } | { edge: SliceEdgeError; held: RunPlaces } {
  let slice = make();
  try {
    return { slice, made: applyDocsRequestsToSlice(slice.piece, requests) };
  } catch (thrown) {
    if (thrown instanceof SliceEdgeError) {
      return { edge: edgeHandedOn(thrown), held: { from: slice.from, to: slice.to } };
    }
    throw new DocModelError(modelRefusal(operation, thrown), thrown);
  }
}

// The edge an attempt hands on: the side and the index of `thrown`, and where it was thrown as
// text. NOT `thrown` ITSELF: until its stack is read, an error holds the frames it was thrown
// from, and with them the draft the model was reading, which is the failed piece.
function edgeHandedOn(thrown: SliceEdgeError): SliceEdgeError {
  let edge = new SliceEdgeError(thrown.side, thrown.index);
  edge.stack = thrown.stack;
  return edge;
}

/**
 * The batch `requests` of an edit `operation` made, applied by the model to the runs of
 * `version` it touches: the first slice is the one the batch names (`batchReach`), and each
 * `SliceEdgeError` is answered here, beneath the wording of a refusal, by the same batch on
 * a wider slice decoded again (`DocStore.widen`), to the whole tab at most. ONE SLICE IS IN
 * HAND AT A TIME: the piece a failed attempt changed is let go before the wider one is
 * decoded. Answers the slice as the model left it and what the model said of it.
 * @throws `DocModelError`, worded for `operation` as `applyDocRequests` words it, for anything
 * else the model throws, AND FOR AN EDGE WITH NO RUN LEFT ON ITS SIDE, which `DocStore.widen`
 * throws back: a slice of every run reads past nothing, so that edge is a fault of the model
 * and is worded as one, the one way a `SliceEdgeError` is ever refused. What a read of
 * storage throws passes as it is.
 * @param decoded The runs the piece the batch was built from decoded, by place: the FIRST
 * slice takes those it names in place of a decode, AND THE MAP IS EMPTIED as soon as that
 * slice is made. A piece keeps the run before its place decoded, which a batch inside one
 * paragraph does not name: emptied, the map holds no run while the model runs and the
 * version is stored. A wider slice is decoded from storage.
 */
export function editedSlice(
  store: DocStore, version: DocVersion, operation: string,
  requests: readonly GoogleDocsRequest[], decoded?: DocPiece["decoded"],
): { slice: DocSlice; made: SliceResult } {
  let tried = attempt(() => {
    try {
      return store.slice(version, batchReach(requests), decoded);
    } finally {
      decoded?.clear();
    }
  }, operation, requests);
  // Each widening holds one run more at least, and a slice of every run throws no edge.
  while ("edge" in tried) {
    let { edge, held } = tried;
    tried = attempt(() => {
      try {
        return store.widen(version, held, edge);
      } catch (thrown) {
        if (thrown !== edge) throw thrown;
        throw new DocModelError(modelRefusal(operation, edge), edge);
      }
    }, operation, requests);
  }
  return tried;
}

/**
 * `edit` made in a version: the requests that make it (`tabEditRequests`) and the version they
 * give. Found stored where the store holds it. Otherwise made: the requests are built from the
 * piece of the version around the edit, which `reading` renders from the runs that hold it;
 * the model applies them to the runs they touch (`editedSlice`), which takes the runs the
 * piece decoded and decodes no run twice; and the version those runs give beside every run
 * left as it was is stored with the result, in one transaction (`DocStore.putSlice`, which
 * renders the runs cut from the slice). The tab is
 * never decoded whole, AND NO RENDERING OF THE TAB BEFORE IS IN HAND ONCE THE BUILDERS HAVE
 * RETURNED: the reading lets go of its piece as it hands the decoded runs on. A refusal by
 * the renderer, the builders or the model is stored too: whatever they throw, before the
 * edit or after it, is a refusal of the edit.
 * @param reading The reading of `version` the caller already asked (a preparation's checks):
 * the build asks it, so nothing it remembers is read again. Made here where the caller has
 * none. HOWEVER THIS CALL ENDS, the reading remembers no piece after it: the piece is taken
 * by the build, and let go where the result was found stored.
 * @throws `DocEditRefusedError` for an edit the version refuses, stored or just made. A version
 * the edit would give an element too large for a row is such a refusal, and is not stored: its
 * reason says that a paragraph or a table of the tab AS THE EDIT WOULD LEAVE IT is too large
 * (`editTooLargeRefusal`), never that the tab is. ANYTHING ELSE IT THROWS IS A FAULT OF STORAGE
 * (a version that cannot be read back, a write refused), never a refusal of the edit: a caller
 * must not treat it as one.
 */
export function docEditResult(
  store: DocStore, version: DocVersion, edit: DocEdit,
  reading: StoredTabReading = storedTabReading(store, version),
): DocEditResult {
  let key = docEditKey(edit);
  let stored = store.result(version, key);
  if (stored) {
    // No build takes the piece a preparation asked before the edit: it is let go here.
    reading.takeDecoded();
    if ("refusal" in stored) throw new DocEditRefusedError(stored.refusal);
    return stored;
  }
  // The refusal `thrown` stands for, stored in a transaction of its own and thrown.
  let refuse = (thrown: unknown): never => {
    let refusal = docRefusal(thrown);
    try {
      store.transaction(() => store.putResult(version, key, { refusal }));
    } catch (error) {
      // The refusal stands whether or not it could be stored: it is made again when asked.
      if (!(error instanceof DocRowTooLargeError)) throw error;
    }
    throw new DocEditRefusedError(refusal);
  };
  // The requests, in a frame of its own, with the runs the piece decoded: the piece's
  // rendering is let go with the frame, before the model is handed a run. What storage threw
  // beneath the reading passes as storage threw it (`unwrapped`).
  let build = (): { requests: GoogleDocsRequest[]; decoded?: DocPiece["decoded"] } =>
    unwrapped(() => {
      let requests: GoogleDocsRequest[];
      try {
        requests = tabEditRequests(reading, edit);
      } catch (thrown) {
        reading.takeDecoded();
        // A fault of storage passes. What the renderer throws on a run is a refusal of the
        // edit, and the builders are pure: whatever else is thrown is a refusal too.
        if (thrown instanceof DocReadingFault) throw thrown;
        return refuse(thrown instanceof DocRunRenderError ? thrown.cause : thrown);
      }
      let decoded = reading.takeDecoded();
      return requests.length > 0 && decoded ? { requests, decoded } : { requests };
    });
  let { requests, decoded } = build();
  // The model, on the runs the batch touches: its refusal is the edit's, and what a read of
  // storage throws passes. An edit that changes nothing gives the version itself.
  let edited: { slice: DocSlice; made: SliceResult } | undefined;
  if (requests.length > 0) {
    try {
      edited = editedSlice(store, version, edit.type, requests, decoded);
    } catch (thrown) {
      if (thrown instanceof DocModelError) return refuse(thrown);
      throw thrown;
    }
  }
  try {
    return store.transaction(() => {
      try {
        // The runs cut from the slice are rendered as they are stored, one by one: what the
        // renderer throws there is marked (`DocRunRenderError`) and refused below.
        let after = edited ? store.putSlice(edited.slice, edited.made) : version;
        store.putResult(version, key, { requests, after });
        return { requests, after };
      } catch (error) {
        if (!(error instanceof DocRowTooLargeError)) throw error;
        throw new DocEditRefusedError({ reason: editTooLargeRefusal(edit, version.tabId, error) });
      }
    });
  } catch (error) {
    // The transaction failed, so nothing of the version the edit gives is stored.
    if (error instanceof DocRunRenderError) return refuse(error.cause);
    // A copy the store found unreadable there was dropped inside the transaction, which the
    // throw undid: it is dropped here, so that the next read fetches.
    if (isDocCopyUnreadable(error)) store.drop(version.doc);
    throw error;
  }
}

/**
 * The reducer of one tab's edits over that tab's base version in `store`. It is given no record
 * that carries `invalidatedReason`: the replay leaves those out of what it folds. An edit is
 * refused, with the reason the caller reads, where the tab is not in the document
 * (`resolveDocTab`'s refusal), the model cannot index it, an earlier refusal of this fold
 * closed the tab's table gate and the edit names a table, or the renderer, the builders or the
 * model refuse it (`DocEditRefusedError`); otherwise the tab becomes
 * `docEditResult(...).after`, or the edit has no effect. A refused edit that changes tables
 * otherwise than in their look closes the gate of the tab it names. It never returns
 * `unsupported`: a tab's queue is folded to its end. A refusal is what the checks made here and
 * `DocEditRefusedError` say; a fault of storage, which only a call of the store throws, passes
 * through the fold, with no record refused for it. The reducer never changes its entity: a
 * version is a handle, and each step answers another. NOTHING PASSES FROM ONE STEP TO THE
 * NEXT BUT THE VERSION: each step makes its own reading of the version it starts from and
 * lets go of it with the step.
 */
export function docTabReducer(
  store: DocStore,
): SimulationStoreOptions<string, DocVersion, DocVersion, QueuedDocRecord, DocRefusal> {
  return {
    initial: base => base,
    reduce(entity, { action }, { id, base, refusals }) {
      replayCost.folds++;
      // Read of storage, so outside any `try`: one small row a step, and a decode only for a
      // record worked out under another digest. A tab a queued add makes has no base and is
      // not asked: it is built with the model's indexes (`blankDocsTab`), which a test holds.
      let unindexed = base !== undefined && store.unindexed(base);
      let refused = (refusal: DocRefusal): EntityStep<DocVersion, DocRefusal> => ({
        kind: "refused",
        refusal: closesTableGate(action) && action.tabId !== undefined
          ? { ...refusal, closesGate: true }
          : refusal,
      });
      let version: DocVersion;
      // These read the record, the handle and the fold's refusals, and no storage.
      try {
        assertDocEditReplayable(action);
        version = entity ?? resolveDocTab<DocVersion>([], id, action.type);
        // Asked before the gate, which the first table change refused for such a tab closes: every
        // edit of the tab is then refused for the one reason, whatever came before it.
        if (unindexed) {
          return refused({ reason: unindexedTabRefusal(action.type).message, unindexed: true });
        }
        if (refusals.some(earlier => earlier.closesGate) && namesTable(action)) {
          throw tableGateRefusal(action.type);
        }
      } catch (error) {
        return refused(docRefusal(error));
      }
      let made: DocEditResult;
      try {
        made = docEditResult(store, version, action);
      } catch (error) {
        if (!(error instanceof DocEditRefusedError)) throw error;
        // The version stands: the next edit of the chain is made in it.
        return refused(error.refusal);
      }
      return made.after.id === version.id
        ? { kind: "known-no-effect" } : { kind: "applied", value: made.after };
    },
  };
}

/**
 * The records of `pending` a read of tab `part` replays: all but those whose write the tab
 * already holds (its marker is among `part.writeMarkers`). Such a record stays pending, and
 * approving it settles it from the same marker. With no `part` (a tab the copy lacks), every
 * record. The records come back as they were given, so a caller that lists stored records gets
 * stored records.
 */
export function replayableDocEdits<R extends QueuedDocRecord>(
  part: DocVersion | undefined, pending: readonly R[],
): R[] {
  return pending.filter(({ action: { writeId } }) =>
    writeId === undefined || !part?.writeMarkers.some(marker => marker.writeId === writeId));
}

// ---------------------------------------------------------------------------
// What an edit changes in a rendering
// ---------------------------------------------------------------------------

/** Whether `index` is where a line of `text` starts. */
function atLineStart(text: string, index: number): boolean {
  return index === 0 || text[index - 1] === "\n";
}

/** How many spaces `text` holds from `index` on. */
function indentAt(text: string, index: number): number {
  let end = index;
  while (text[end] === " ") end++;
  return end - index;
}

/**
 * The span of a tab's rendering an edit changes: `start` to `beforeEnd` in `before` and `start`
 * to `afterEnd` in `after`, the renderings before and after it. Outside the span the two are the
 * same text. With `named`, the range of `before` the caller's text stands at, the span holds
 * that range, and is widened to whole lines only on a side where the difference reaches past it.
 * Without it the span is the lines that differ, each whole. Lines that are only added, and could
 * stand several lines earlier with the same result (a table row added before a row that begins
 * as it does), are placed where their first line is indented least, at the latest such place.
 *
 * With `open`, which says whether the two tabs read on, alike, before and after the two
 * strings: answers `{ more }` in place of a span that the text beyond could change: `"after"`
 * where one string is the whole start of the other, they differ in length, and the span's
 * start is found from that common start (no range is named, or the common start ends before
 * the named range starts); `"before"` where lines are only added and the walk back through
 * equal lines reached the strings' start. Two equal strings give a span, never `more`, and so
 * does a named range the common start reaches. On a side that is open the strings start at a
 * line start, and end after a line break: a line is then never looked for past them.
 */
export function changedSpan(
  before: string, after: string, named?: { start: number; end: number },
): { start: number; beforeEnd: number; afterEnd: number };
export function changedSpan(
  before: string, after: string, named: { start: number; end: number } | undefined,
  open: { readonly before: boolean; readonly after: boolean },
): { start: number; beforeEnd: number; afterEnd: number } | { more: "before" | "after" };
export function changedSpan(
  before: string, after: string, named?: { start: number; end: number },
  open?: { readonly before: boolean; readonly after: boolean },
): { start: number; beforeEnd: number; afterEnd: number } | { more: "before" | "after" } {
  // THE SPAN OF TWO LOCAL STRINGS IS THE TWO TABS' SPAN, MOVED, WHILE NOTHING BELOW READS PAST
  // THEM. Two reads do, and no other: the common start, where it is the whole of one string
  // (the tabs' common start then runs on into the text after), and the walk back over equal
  // lines, where it ends at the strings' start. Everything else reads between the span's start
  // and the strings' ends: the common end is counted back from those ends to the span's start
  // (text added alike after both strings moves it by its own length), a line's start is looked
  // for from inside the strings (they start at a line start), and a line's end is looked for
  // after a character that differs, which the strings hold with their line break.
  let left = commonPrefix(before, after);
  // With a range named that the common start reaches, the span starts at the range whatever
  // follows, and nothing else reads the common start.
  if (open?.after && before.length !== after.length &&
      left === Math.min(before.length, after.length) && (!named || left < named.start)) {
    return { more: "after" };
  }
  let start = named && left >= named.start ? named.start : lineStart(before, left);
  // Bounded by the span's start, not by the common prefix: text between the two may belong to
  // the suffix, as where an insertion repeats the text after it.
  let changedEnd = before.length - commonSuffix(before, after, start);
  let beforeEnd: number;
  if (named && changedEnd <= named.end) {
    beforeEnd = named.end;
  } else if (atLineStart(before, changedEnd)) {
    beforeEnd = changedEnd;
  } else {
    let lineEnd = before.indexOf("\n", changedEnd);
    beforeEnd = lineEnd === -1 ? before.length : lineEnd;
  }
  let afterEnd = after.length - (before.length - beforeEnd);

  if (!named && start === beforeEnd && afterEnd > start && after[afterEnd - 1] === "\n") {
    // Whole lines were added and nothing removed. While the line before the span is also the
    // span's last line, the same lines stand one line earlier with the same result.
    let moved = 0;
    let least = indentAt(after, start);
    let differed = false;
    for (let shift = 0; start - shift > 0;) {
      let from = start - shift;
      let line = after.slice(lineStart(after, from - 1), from);
      let last = afterEnd - shift - line.length;
      if (last < from || !atLineStart(after, last) || !after.startsWith(line, last)) {
        differed = true;
        break;
      }
      shift += line.length;
      let indent = indentAt(after, start - shift);
      if (indent < least) {
        least = indent;
        moved = shift;
      }
    }
    // The walk ended at the strings' start, not at a line that differs: the line before the
    // strings may be equal too.
    if (open?.before && !differed) return { more: "before" };
    start -= moved;
    beforeEnd -= moved;
    afterEnd -= moved;
  }
  return { start, beforeEnd, afterEnd };
}
