/**
 * The Google Doc edits: how each is stored, replayed over a copy of the document, described to
 * the approver and written once approved, over the host of whichever connection queued it.
 */
import { ActionKind } from '@gadgets/workshop-shared/gatekeeper';
import {
  ActionApplyError, type ActionDefinition, type ActionPresentation,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline } from "@gadgets/gatekeeper-kit/action-description";
import { createSimulationView } from "@gadgets/gatekeeper-kit/simulation";
import {
  createSimulationStore, type SimulationStoreOptions,
} from "@gadgets/gatekeeper-kit/simulation-store";
import { type GoogleDocTab } from "./docs-types";
import {
  blankDocsTab, docsWriteFailure, GoogleDocsApi, type DocsBatchReply, type GoogleDocReader,
  type GoogleDocsAddTabRequest, type GoogleDocsBatchRequest, type GoogleDocsDocument,
  type GoogleDocsTab,
} from "./docs-api";
import { replayCost } from "./docs-model";
import { unwrapped } from "./docs-reading";
import {
  assertDocEditReplayable, docEditKey, DocEditRefusedError, docEditResult, docEditTab, docRefusal,
  docTabReducer, replayableDocEdits, type DocEdit, type DocRefusal,
} from "./docs-replay";
import { storedIn, type DocCopy } from "./docs-copy";
import {
  DOC_COPY_UNREADABLE, googleDocNamedRangeIds, googleDocNamedRanges, googleDocWriteMarkerName,
  pruneTab, type GoogleDocTabIdentity,
} from "./docs-replica";
import { DocRunRenderError, type DocPending, type DocStore, type DocVersion } from "./docs-store";
import { DOCUMENT_TABLES, type PreparedTableChange } from "./docs-table-actions";
import { namesTable, tableGateRefusal, type TableChange } from "./docs-tables";
import { insertDocTab, type DocTabPlacement } from "./docs-tabs";
import { GoogleApiError } from "./google-response";
import {
  assertMarkdownWriteComplexity, canonicalizeMarkdownForWrite, type DocTabSnapshot,
} from "./markdown-converter";
import { obsContext } from "./observability.js";
import { explainUnopenedFile } from "./office-conversion";
import { PendingActionStore } from "./pending-actions";

const logger = obsContext.createLogger({ component: "gatekeeper.google", vendorId: "google" });

type GoogleDocActionBase = {
  submittedAt: number;
  baseRevisionId?: string;
  writeId?: string;
  invalidatedReason?: string;
  /** The Markdown version the edit was previewed under. */
  markdownVersion?: number;
}

/**
 * What a text edit's card shows beyond the edit itself, recorded with it, since a card is built
 * once, from the stored edit. Display only: nothing replays or applies it.
 */
type GoogleDocEditDisplay = {
  /** The tab's label, as the card names it. */
  tab: string;
  /**
   * What a read returns of the edit once it is made, where the card cannot tell it from the edit:
   * for a replacement, the text it leaves in the span the card shows, where that is not the
   * span with the text asked for; for an append, what it adds to the tab, where that is not the
   * canonical form of the text asked for (`canonicalizeMarkdownForWrite`).
   */
  rendered?: string;
  /**
   * The text of the tab on each side of the text a replacement names, where the card shows more
   * of the tab than that text (`changedSpan` widens a span on a side where the change reaches
   * past it). The card's old text is `before + oldMarkdown + after` and its requested text
   * `before + newMarkdown + after`, so the edit's own texts are stored once.
   */
  context?: { before: string; after: string };
  /** The card's prose, where it is not that of a replacement outside tables. */
  prose?: string;
};

/** What a tab add's card says beyond its title. */
type GoogleDocAddTabDisplay = {
  /** Where the tab goes, as the card's description says it. */
  placement: string;
};

/** A change to the text of one tab. */
type GoogleDocEditBase = GoogleDocActionBase & {
  /**
   * The tab this edit targets. Absent only on records stored before tab support, which are
   * invalidated rather than retargeted: the first tab is not necessarily the one they meant.
   */
  tabId?: string;
  /** Absent on records stored before cards were built from records. */
  display?: GoogleDocEditDisplay;
}

type GoogleDocReplaceAction = GoogleDocEditBase & Extract<DocEdit, { type: "replaceText" }>;

type GoogleDocAppendAction = GoogleDocEditBase & Extract<DocEdit, { type: "appendText" }>;

/** A new, empty tab, placed under `parentTabId` at `index` as `addDocumentTab` places it. */
export type GoogleDocAddTabAction = GoogleDocActionBase & DocTabPlacement & {
  type: "addTab";
  /**
   * The ID the agent was given for the tab, which Google names only once it is added. Edits
   * queued for the tab name it until then, and are pointed at Google's ID when the add applies.
   */
  provisionalTabId: string;
  title: string;
  /**
   * Every tab ID the document held when the add was sent, kept until Google refuses that send: a
   * retry that finds no marker checks it for any tab that has appeared since.
   */
  knownTabIds?: string[];
  /** Absent on records stored before cards were built from records. */
  display?: GoogleDocAddTabDisplay;
}

/** A change to a tab's tables, stored as replay and approval make it. */
type GoogleDocTableAction = GoogleDocActionBase & TableChange & {
  tabId?: string;
  /** The card prepared for it, from the tab before and after the change. */
  display?: Pick<PreparedTableChange, "title" | "description">;
};

/**
 * A change to one tab's content: a text edit or a change to its tables, replayed and applied as
 * `docs-replay` makes it.
 */
export type GoogleDocEditAction =
  GoogleDocReplaceAction | GoogleDocAppendAction | GoogleDocTableAction;
export type GoogleDocAction = GoogleDocEditAction | GoogleDocAddTabAction;

export const DOC_WRITE_RECEIPT_KEY = "docWriteReceipt";
export const DOC_METADATA_REVISION_KEY = "docMetadataRevision";
/** How long the copy of the document is served before its revision is checked. */
export const DOC_SNAPSHOT_TTL_MS = 10_000;
/**
 * How long after Google returned a revision id a write may be pinned to it. Google documents
 * a revision id as valid for 24 hours after it was returned, so a copy fetched longer ago
 * builds no write and the document is read.
 */
export const DOC_REVISION_PIN_MS = 24 * 60 * 60 * 1000;

/** Whether a write may be pinned at `now` to a revision id Google returned at `returnedAt`. */
export function docRevisionPins(returnedAt: number, now: number = Date.now()): boolean {
  return now - returnedAt <= DOC_REVISION_PIN_MS;
}
/** Prefix of the ID `addTab()` returns for a tab Google has not added yet. */
export const PROVISIONAL_TAB_PREFIX = "pending-tab-";
/** Each added tab's provisional ID to the ID Google gave it, oldest first. */
export const DOC_ADDED_TABS_KEY = "docAddedTabs";
/** How many added tabs' provisional IDs keep resolving after their adds apply. */
export const MAX_DOC_ADDED_TABS = 100;
/** The context a read's replay gives an action it invalidates. */
export const REPLAY_CONTEXT =
  "Pending Google Doc edit could not be replayed against the current document";

/** A landed write whose marker is still to be deleted, and the edit it was. */
export type GoogleDocWriteReceipt = {
  actionId: number;
  markerId: string;
  /** The tab the marker is in, where the connection records it. */
  tabId?: string;
};

/** The document revision this binding has already reported, and when it first saw it. */
export type GoogleDocMetadataRevision = { revisionId?: string; observedAt: number };

/** A document as last read: its copy, which pending actions are replayed over. */
export type GoogleDocSnapshot = {
  /** Absent unless the caller can edit the document; see `GoogleDocsDocument.revisionId`. */
  revisionId?: string;
  /**
   * A view of the copy, valid until the next await (`DocCopy`). Read it inside
   * `DocSource.read`: a snapshot a Drive source fetched and has not kept holds a copy that
   * lists the tabs and reads none (`unkeptDocCopy`), and `read` hands its `use` one that does.
   */
  copy: DocCopy;
  /** `Date.now()` at the time of fetch, used for TTL checks. */
  fetchedAt: number;
  /**
   * The document's title, where the fetch that brought this snapshot answered it to this
   * call (`HeldDocCopy.title`); absent for a snapshot served from a stored copy, and for a
   * Doc read through Drive, whose file's name is its title.
   */
  title?: string;
};

/**
 * Whether an expired snapshot still describes the current document.
 *
 * Google withholds `revisionId` from a caller without edit access, leaving no change token, so
 * such a document is refetched rather than spending a request on an answer that could never
 * confirm the cache.
 */
export async function googleDocRevisionUnchanged(
  docsApi: GoogleDocReader,
  documentId: string,
  cached: GoogleDocSnapshot,
): Promise<boolean> {
  return cached.revisionId !== undefined &&
      await docsApi.getRevisionId(documentId) === cached.revisionId;
}

export type { GoogleDocTabIdentity };

/** The identity of a tab an add makes, before it is placed (`insertDocTab` places it). */
export function blankDocTabIdentity(tabId: string, title: string): GoogleDocTabIdentity {
  return { tabId, title, index: 0, nestingLevel: 0 };
}

/** The agent-facing view of one tab: identity and position, never content. */
export function googleDocTabMetadata(tab: GoogleDocTabIdentity): GoogleDocTab {
  return {
    id: tab.tabId,
    title: tab.title,
    ...tab.parentTabId === undefined ? {} : { parentTabId: tab.parentTabId },
    index: tab.index,
    nestingLevel: tab.nestingLevel,
  };
}

/**
 * How a tab is named in approval and observation text.
 *
 * The ID is included because it is what the write actually targets: titles are user-authored,
 * are not required to be unique, and may be empty. A tab still waiting for its add has only a
 * provisional ID, which names nothing the user can find, so it is called a new tab instead: its
 * own approval, queued before, shows where it goes. The title sits in prose, so it is flattened
 * with `plainInline` and cannot open Markdown or HTML structure there.
 */
export function googleDocTabLabel(tab: Pick<GoogleDocsTab, "tabId" | "title">): string {
  let id = tab.tabId.startsWith(PROVISIONAL_TAB_PREFIX) ? "new tab" : tab.tabId;
  return `"${plainInline(tab.title)}" (${id})`;
}

export function parseGoogleDocWriteReceipt(value: unknown): GoogleDocWriteReceipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  let { actionId, markerId, tabId } =
    value as { actionId?: unknown; markerId?: unknown; tabId?: unknown };
  if (typeof actionId !== "number" || !Number.isSafeInteger(actionId) || actionId < 1 ||
      typeof markerId !== "string" || markerId.length === 0 ||
      (tabId !== undefined && typeof tabId !== "string")) {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  return { actionId, markerId, ...(tabId === undefined ? {} : { tabId }) };
}

export type GoogleDocPendingAction = { id: number; action: GoogleDocAction };

/**
 * Why an add whose marker the document holds, but whose reply was lost, is refused rather than
 * adopted: Google names a new tab only in that reply. It takes no tab ID from the caller, and a
 * marker sent in the same batch cannot go in the tab the batch makes, so nothing else tells which
 * tab it is; a title and place could be a collaborator's tab, made after deleting this one.
 */
function googleDocLostAddError(action: GoogleDocAddTabAction): Error {
  return new Error(
    `Google Docs added the tab "${action.title}", but its reply was lost, and nothing else tells ` +
    "which tab it is. It stays in the document, where listTabs() shows it.");
}

/**
 * Refuses to send again an add whose earlier send has no known outcome and whose marker is gone,
 * once any tab has appeared anywhere in the document since (outside the `knownTabIds` recorded
 * before that send): a collaborator may have moved the tab it made under another parent. Nothing
 * ties such a tab to this add, whose send may never have reached Google, so it is not adopted; nor
 * is the add sent again, which could make a second.
 */
function assertGoogleDocAddUnsent(
  tabs: readonly { tabId: string }[], action: GoogleDocAddTabAction,
): void {
  let known = new Set(action.knownTabIds);
  let appeared = tabs.filter(tab => !known.has(tab.tabId));
  if (appeared.length > 0) {
    throw new Error(
      `The add of tab "${action.title}" may have reached Google, but no marker of it is left, and ` +
      `${appeared.length === 1 ? "a tab has" : `${appeared.length} tabs have`} appeared in the ` +
      "document since, so whether it was added is unknown.");
  }
}

/** The ID of the tab an `addDocumentTab` reply names, if it names one. */
function googleDocReplyTabId(reply: DocsBatchReply | undefined): string | undefined {
  let tabId = reply?.addDocumentTab?.tabProperties?.tabId;
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

/**
 * The ID Google gave the tab `tabId` names, when it is the provisional ID of a tab whose add has
 * applied, and otherwise `tabId` itself.
 */
export function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string): string;
export function adoptedGoogleDocTabId(
  kv: DurableObjectStorage["kv"], tabId: string | undefined,
): string | undefined;
export function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string | undefined) {
  if (!tabId?.startsWith(PROVISIONAL_TAB_PREFIX)) return tabId;
  return kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY)?.[tabId] ?? tabId;
}

/** The entity id of the document's tab tree in the fold of the tab tree. */
export const DOC_OUTLINE = "";

/** What a connection keeps of one document for its activation. */
export type GoogleDocSimulationCacheHolder = {
  /** The writes landed, counted so a read awaiting Google across one can tell. */
  writes: number;
}

/**
 * The pending actions a replay of tab `tabId` folds, as a string to compare: the edits that name
 * the tab, those that name none, and the add that makes it. It differs once one of them was
 * approved, rejected or dropped, and not for what became of another tab's edits, which the
 * replay of this tab does not read.
 */
export function googleDocPendingFingerprint(
  pending: GoogleDocPendingAction[], tabId: string,
): string {
  replayCost.fingerprints++;
  return JSON.stringify(pending.filter(({ action }) => action.type === "addTab"
    ? action.provisionalTabId === tabId
    : action.tabId === undefined || action.tabId === tabId));
}

const MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES = 1024 * 1024;
const googleDocActionEncoder = new TextEncoder();

/** Whether `values` hold more UTF-8 bytes between them than one edit's texts may. */
function exceedsGoogleDocActionBytes(values: string[]): boolean {
  // UTF-16 length is a lower bound on UTF-8 bytes, so an oversized input is refused unencoded.
  let byteLength = values.reduce((total, value) => total + value.length, 0);
  if (byteLength <= MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    byteLength = values.reduce(
      (total, value) => total + googleDocActionEncoder.encode(value).byteLength, 0);
  }
  return byteLength > MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES;
}

export function assertGoogleDocActionMarkdownSize(...values: string[]): void {
  if (exceedsGoogleDocActionBytes(values)) {
    throw new Error(
      `Google Doc action Markdown exceeds the ${MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES}-byte ` +
      "safe submission limit.",
    );
  }
  for (let value of values) assertMarkdownWriteComplexity(value);
}

/**
 * Throws where what a text edit's card shows beyond the edit is too much to store with it:
 * `display.rendered` and `display.context` are held, between them, to the bytes the edit's own
 * texts are held to (`assertGoogleDocActionMarkdownSize`), so a stored text edit is at most
 * twice that. `operation` names the call in the refusal.
 */
export function assertGoogleDocDisplaySize(operation: string, display: GoogleDocEditDisplay): void {
  let { rendered = "", context = { before: "", after: "" } } = display;
  if (exceedsGoogleDocActionBytes([rendered, context.before, context.after])) {
    throw googleDocDisplayLimit(operation).refusal();
  }
}

/**
 * The limit a text edit's card is held to beyond the edit's own texts, for `operation`: the
 * characters past which what it shows is certainly too much (a lower bound of its bytes),
 * and the refusal `assertGoogleDocDisplaySize` throws.
 */
export function googleDocDisplayLimit(operation: string): { readonly chars: number; refusal(): Error } {
  return {
    chars: MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES,
    refusal: () => new Error(
      `${operation}: what this edit's approval card would show exceeds the ` +
      `${MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES}-byte safe submission limit. ` +
      "Split the edit into smaller ones."),
  };
}

/** Throws for a stored add that no longer replays. A new tab holds no Markdown to have aged. */
function assertGoogleDocActionReplayable(action: GoogleDocAddTabAction): void {
  if (action.invalidatedReason) throw new Error(action.invalidatedReason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function invalidateGoogleDocAction(
  pendingActions: PendingActionStore<GoogleDocAction>,
  pending: GoogleDocPendingAction,
  reason: string,
): void {
  if (!pending.action.invalidatedReason) {
    pending.action.invalidatedReason = reason;
    pendingActions.put(pending.id, pending.action);
  }
}

/** The invalidator of a store that marks such an edit in its record. */
export function storeInvalidator(pendingActions: PendingActionStore<GoogleDocAction>): GoogleDocInvalidator {
  return (record, reason) => invalidateGoogleDocAction(pendingActions, record, reason);
}

/**
 * The tabs that could hold the write marker of `action`.
 *
 * A marker lives in the tab its write landed in, so one elsewhere belongs to a different write.
 * A pre-tab-support edit names no tab, so its marker — and therefore the proof that its write
 * already committed — could be in any of them; so could a new tab's, which goes in its parent or
 * in the first tab, whichever was there when it was sent.
 */
function googleDocActionTabs<T extends { tabId: string }>(tabs: T[], action: GoogleDocAction): T[] {
  let tabId = action.type === "addTab" ? undefined : action.tabId;
  return tabId === undefined ? tabs : tabs.filter(tab => tab.tabId === tabId);
}

/** Records that edit `record` can no longer be replayed, for `reason`. */
export type GoogleDocInvalidator = (record: GoogleDocPendingAction, reason: string) => void;

/**
 * The reducer of the tab tree. An add puts the tab it makes where Google will (`insertDocTab`),
 * under its provisional id, or is refused where its place is gone. An edit that names no tab
 * (stored before tabs could be named) is refused where it no longer replays at all
 * (`assertDocEditReplayable`, asked first, as the tab reducer asks it), then once the document
 * has more than one tab, as `docEditTab` refuses it, and otherwise has no effect here.
 */
export const googleDocOutlineReducer: SimulationStoreOptions<
  typeof DOC_OUTLINE, readonly GoogleDocTabIdentity[], readonly GoogleDocTabIdentity[],
  GoogleDocPendingAction, DocRefusal> = {
    initial: outline => outline,
    reduce(outline = [], { action }) {
      replayCost.folds++;
      try {
        if (action.type === "addTab") {
          let { provisionalTabId, title, parentTabId, index } = action;
          return {
            kind: "applied",
            value: insertDocTab(
              outline, blankDocTabIdentity(provisionalTabId, title), { parentTabId, index }),
          };
        }
        assertDocEditReplayable(action);
        docEditTab(outline, action);
        return { kind: "known-no-effect" };
      } catch (error) {
        return { kind: "refused", refusal: docRefusal(error) };
      }
    },
  };

/**
 * What the pending records `pending` of document `doc` still reach in `store`, for
 * `DocStore.keep`, `trial` and `sweep`: the key (`docEditKey`) of every edit that carries no
 * reason, and the version of the blank tab each pending add makes (`DocStore.versionId` of
 * `blankDocTabToKeep`), which is where the edits queued in that tab start.
 */
export function pendingDocKeys(
  store: DocStore, doc: string, pending: readonly GoogleDocPendingAction[],
): DocPending {
  let edits: string[] = [];
  let roots: string[] = [];
  for (let { action } of pending) {
    if (action.invalidatedReason) continue;
    if (action.type === "addTab") roots.push(store.versionId(doc, blankDocTabToKeep(action)));
    else edits.push(docEditKey(action));
  }
  return { edits, roots };
}

/**
 * The tab a pending add makes, as the replay stores it: blank, pruned, under its provisional
 * id. The one place it is built, so the replay's version and the sweep's root are one.
 */
export function blankDocTabToKeep(action: GoogleDocAddTabAction): GoogleDocsTab {
  return pruneTab(blankDocsTab(action.provisionalTabId, action.title));
}

/**
 * The reducer of one tab over `copy`'s store. An add makes the tab, blank, under its provisional
 * id (its place is the outline's to hold); an edit reduces as `docTabReducer` reduces it.
 */
export function googleDocTabReducer(
  copy: NonNullable<DocCopy["stored"]>,
): SimulationStoreOptions<string, DocVersion, DocVersion, GoogleDocPendingAction, DocRefusal> {
  let edits = docTabReducer(copy.store);
  return {
    initial: edits.initial,
    reduce(tab, { id, action }, context) {
      if (action.type !== "addTab") return edits.reduce(tab, { id, action }, context);
      replayCost.folds++;
      return tab === undefined
        ? { kind: "applied", value: copy.store.putTab(copy.doc, blankDocTabToKeep(action), []) }
        : { kind: "known-no-effect" };
    },
  };
}

/** The fold of a document's tab tree over the copy's outline. It reads no store. */
const outlineFold = createSimulationStore(googleDocOutlineReducer);

/** The entities `action` changes in a replay over `copy`: the tab tree, a tab, or both. */
function docTargets(copy: DocCopy): (action: GoogleDocAction) => readonly string[] {
  // An edit that names no tab is one of the only tab, while the copy has one.
  let unnamed = copy.outline.length === 1 ? [DOC_OUTLINE, copy.outline[0].tabId] : [DOC_OUTLINE];
  return action => action.type === "addTab"
    ? [DOC_OUTLINE, action.provisionalTabId]
    : action.tabId === undefined ? unnamed : [action.tabId];
}

/** A document's pending actions as a connection lists and invalidates them. */
export type GoogleDocReplayQueue = {
  /** Oldest first, read from the connection's storage at each call. */
  pending(): GoogleDocPendingAction[];
  invalidate: GoogleDocInvalidator;
};

/** The reason stored with an action that a replay dropped; `context` says which replay. */
export function googleDocDroppedReason(context: string, reason: string): string {
  return `${context}: ${reason} This edit was dropped from the document. ` +
    `Reject it and retry if it is still needed.`;
}

/**
 * One replay of a document's queue over a copy of it. USE IT AT ONCE, awaiting nothing: it holds
 * the pending list as it read when it was made.
 */
export type GoogleDocReplay = {
  /**
   * The document's tabs by identity, in the document's order and with the tabs queued adds make.
   * No tab's content was read for it.
   */
  readonly outline: readonly GoogleDocTabIdentity[];
  /**
   * Tab `tabId` as it stands with its own pending edits replayed over that tab of the copy alone,
   * or `undefined` for a tab neither the document nor a queued add holds. Only the records that
   * target the tab are folded; an edit the replay refuses is invalidated, with the replay's
   * context and the refusal, and the tab returned is that of a queue in which every one of its
   * edits applied or was already invalid. An edit whose marker the tab holds is not replayed
   * (`replayableDocEdits`); an add always is, since only its approval can tell its reply was
   * lost. Asked again for the same tab, it answers what it answered. The tab is answered as its
   * version in the copy's store, valid until the next await.
   *
   * Once a change to the tab's tables fails, the later changes that name a table of it by how it
   * read are refused with it: they recorded their tables with the failed change applied.
   */
  tab(tabId: string): DocVersion | undefined;
};

/**
 * Logs what the model did where it refused `record`, or that the record's batch left the piece
 * of the tab it was built from. Nothing else is logged: an edit that no longer applies is the
 * ordinary case.
 */
function logReplayRefusal(record: GoogleDocPendingAction, refusal: DocRefusal): void {
  if (refusal.unindexed) {
    logger.warn("Google Doc tab cannot be indexed by the model", {
      event: "google.doc.tab.unindexed", actionId: record.id, operation: record.action.type,
    });
  } else if (refusal.unmodelled) {
    logger.warn("Google Doc edit cannot be replayed by the model", {
      event: "google.doc.replay.unmodelled", actionId: record.id,
      modelShape: refusal.unmodelled.what, modelInvariant: refusal.unmodelled.invariant,
    });
  } else if (refusal.modelError) {
    logger.error("Google Doc edit was refused by the model of Google Docs", {
      event: "google.doc.replay.model-refused", actionId: record.id,
      outcome: refusal.modelError.name,
      ...(refusal.modelError.frames ? { modelStack: refusal.modelError.frames } : {}),
    });
  } else if (refusal.overreach) {
    logger.error("Google Doc edit's batch reaches past the piece of the tab it was built from", {
      event: "google.doc.piece.overreach", actionId: record.id, operation: record.action.type,
      side: refusal.overreach,
    });
  }
}

/** `replayGoogleDoc`, and beside the replay the ids of the tabs a pending record targets. */
function replayDoc(
  queue: GoogleDocReplayQueue, copy: DocCopy, context: string,
): GoogleDocReplay & { readonly targeted: ReadonlySet<string> } {
  replayCost.queueReads++;
  let active = queue.pending().filter(({ action }) => !action.invalidatedReason);
  let targets = docTargets(copy);
  let view = createSimulationView(active, targets);
  let targeted = new Set(active.flatMap(({ action }) => targets(action)));
  targeted.delete(DOC_OUTLINE);

  // A queue's `invalidate` marks the record in hand or removes it from the journal and leaves the
  // one in hand as it was, so what this replay invalidated is kept here and left out of every
  // list it folds afterwards.
  let invalidated = new Set<number>();
  let live = (records: readonly GoogleDocPendingAction[]) =>
    records.filter(({ id }) => !invalidated.has(id));
  let settle = (
    refused: readonly { readonly record: GoogleDocPendingAction; readonly refusal: DocRefusal }[],
  ) => {
    for (let { record, refusal } of refused) {
      logReplayRefusal(record, refusal);
      invalidated.add(record.id);
      queue.invalidate(record, googleDocDroppedReason(context, refusal.reason));
    }
  };

  // The tab tree first: a record it refuses reaches no tab's fold. An edit that names no tab is
  // left out where a tab already holds its write, which is asked only for such an edit, since it
  // reads every tab.
  let tree = outlineFold.fold(DOC_OUTLINE, copy.outline, view.forTarget(DOC_OUTLINE).filter(
    ({ action }) => action.type === "addTab" || action.writeId === undefined ||
      !copy.outline.some(({ tabId }) =>
        copy.tab(tabId)?.writeMarkers.some(marker => marker.writeId === action.writeId))));
  settle(tree.refused);
  let outline = tree.entity ?? [];
  let listed = new Set(outline.map(({ tabId }) => tabId));

  // The fold of one tab's records over that tab's version in the copy's store, made for this
  // replay and gone with it.
  let tabFold = createSimulationStore(googleDocTabReducer(storedIn(copy)));

  // The edits of a tab neither the document nor a queued add holds are refused here, reading no
  // tab.
  for (let tabId of targeted) {
    if (listed.has(tabId)) continue;
    settle(tabFold.fold(tabId, undefined, live(view.forTarget(tabId))).refused);
  }

  let answered = new Map<string, DocVersion | undefined>();
  return {
    outline,
    targeted,
    tab(tabId) {
      if (!listed.has(tabId)) return undefined;
      if (answered.has(tabId)) return answered.get(tabId);
      let part = copy.tab(tabId);
      let fold = tabFold.fold(tabId, part, live(view.forTarget(tabId)).filter(
        ({ id, action }) =>
          action.type === "addTab" || replayableDocEdits(part, [{ id, action }]).length > 0));
      settle(fold.refused);
      answered.set(tabId, fold.entity);
      return fold.entity;
    },
  };
}

/**
 * Replays the tab tree of `queue` over `copy` and answers the replay, whose tabs are replayed as
 * they are asked for. Made here, before any tab is read: an add the replay refuses is
 * invalidated, with `context` and the refusal; so is every edit that names a tab the document
 * and the queued adds do not hold, and an edit that names none once the document has several. A
 * record that carries a reason, and one this replay invalidated, is left out of everything the
 * replay folds afterwards, whether the queue's `invalidate` marks the record or removes it. The
 * queue's pending list is read once. Synchronous.
 */
export function replayGoogleDoc(
  queue: GoogleDocReplayQueue, copy: DocCopy, context: string,
): GoogleDocReplay {
  let { outline, tab } = replayDoc(queue, copy, context);
  return { outline, tab };
}

/**
 * Replays the whole queue over `copy` for what it invalidates: the tab tree, then every tab a
 * pending edit targets, over one read of the pending list. For the replay after an approval,
 * whose new revision may refuse edits of any tab. Synchronous.
 */
export function replayGoogleDocActions(
  queue: GoogleDocReplayQueue, copy: DocCopy, context: string,
): void {
  let replay = replayDoc(queue, copy, context);
  for (let { tabId } of replay.outline) {
    if (replay.targeted.has(tabId)) replay.tab(tabId);
  }
}

/**
 * Invalidates the edits queued after `actionId` that name a table of tab `tabId` by how it read:
 * the tab's tables may no longer be as those edits found them, and no replay refuses them for
 * that. The caller has no copy to replay over, or the edit that failed is one a replay skips.
 * Does nothing for `tabId` undefined.
 */
export function invalidateTableChangesBehind(
  queue: GoogleDocReplayQueue, tabId: string | undefined, actionId: number, context: string,
): void {
  if (tabId === undefined) return;
  for (let record of queue.pending()) {
    let { action } = record;
    if (record.id <= actionId || action.invalidatedReason || action.type === "addTab" ||
        action.tabId !== tabId || !namesTable(action)) {
      continue;
    }
    queue.invalidate(
      record, googleDocDroppedReason(context, tableGateRefusal(action.type).message));
  }
}

/**
 * Logs what the model of Google Docs did where it refused the edit a call to `operation` would
 * queue, or that the edit's batch left the piece of the tab it was built from (the operation
 * and the side, and nothing of the batch). The caught value is not passed as `error`, since
 * the logger writes its message and a fault of the model can word one from the document: the
 * class name and the frames of the throw say what failed and where. A refusal that carries
 * no mark (an edit the document refuses in words) logs nothing.
 */
export function logModelRefusal(operation: string, error: unknown): void {
  let { unmodelled, modelError, overreach } = docRefusal(error);
  if (unmodelled) {
    logger.warn("Google Doc edit cannot be shown by the model", {
      event: "google.doc.prepare.unmodelled", operation,
      modelShape: unmodelled.what, modelInvariant: unmodelled.invariant,
    });
  } else if (modelError) {
    logger.error("Google Doc edit was refused by the model of Google Docs", {
      event: "google.doc.prepare.model-refused", operation, outcome: modelError.name,
      ...(modelError.frames ? { modelStack: modelError.frames } : {}),
    });
  } else if (overreach) {
    logger.error("Google Doc edit's batch reaches past the piece of the tab it was built from", {
      event: "google.doc.piece.overreach", operation, side: overreach,
    });
  }
}

/** What approval sends for one action, with the tab its write marker goes in, and where. */
type MaterializedGoogleDocAction = {
  tab: Pick<DocTabSnapshot, "tabId" | "bodyEndIndex">;
  requests: readonly GoogleDocsBatchRequest[];
};

/**
 * The request adding a tab, refused where Google would refuse it. Its write marker goes in a tab
 * that exists: its parent, or the first tab.
 */
function materializeGoogleDocAddTab(
  tabs: GoogleDocsTab[],
  action: GoogleDocAddTabAction,
): MaterializedGoogleDocAction {
  assertGoogleDocActionReplayable(action);
  let { provisionalTabId, title, parentTabId, index } = action;
  insertDocTab(tabs, blankDocsTab(provisionalTabId, title), { parentTabId, index });
  let marked = tabs.find(candidate => candidate.tabId === parentTabId) ?? tabs[0];
  let tab = { tabId: marked.tabId, bodyEndIndex: marked.body.content.at(-1)?.endIndex ?? 0 };
  let request: GoogleDocsAddTabRequest = {
    addDocumentTab: {
      tabProperties: {
        title,
        ...parentTabId === undefined ? {} : { parentTabId },
        ...index === undefined ? {} : { index },
      },
    },
  };
  return { tab, requests: [request] };
}

/**
 * The kind of the text edits: replaceText, in table cells too, and appendText. A new tab has a
 * kind of its own, and so has every change to a table (`DOCUMENT_TABLES`), to its look too.
 */
export const EDIT_DOCUMENT_ACTION: ActionKind = {
  tag: "editDocument",
  label: "Document edits",
};

/** New tabs, a kind of their own since edits already have an auto-approvable one. */
export const ADD_DOCUMENT_TAB_ACTION: ActionKind = {
  tag: "addDocumentTab",
  label: "New document tabs",
};

/** A write's marker, found with the tab it is in, which deleting it must name. */
export type GoogleDocWriteMarker = { id: string; tabId: string };

/** What applying a Doc edit needs of the connection it was queued on. */
export type DocHost = {
  api: GoogleDocsApi;
  documentId: string;
  /** The MIME type Drive gives the file, asked only to explain a write Google refused. */
  mimeType(): Promise<string | undefined>;
  /** The write whose marker is still to be deleted, if there is one. */
  receipt(): GoogleDocWriteReceipt | undefined;
  /** Forgets the receipt of marker `markerId`, which is gone from the document. */
  clearReceipt(markerId: string): void;
  /** Stores `action`, edit `id`, as it now stands: an add records the tabs it is sent over. */
  saved(id: number, action: GoogleDocAction): void;
  /**
   * Records that edit `id` landed, with the marker its write left, or none for an edit that sent
   * no request, and for an add, the tab it made.
   */
  landed(
    id: number, marker: GoogleDocWriteMarker | undefined,
    addedTab?: { provisionalTabId: string; tabId: string },
  ): void;
  /**
   * Records that `action`, edit `id`, can no longer be applied, for `reason`, and fails the table
   * changes queued behind it in its tab when it is one that changes tables.
   */
  unapplyable(id: number, action: GoogleDocAction, reason: string): Promise<void>;
  /**
   * The copy of the document this connection holds and a write may be built from, with the
   * revision it was fetched at, or `undefined` for none: nothing held, a write landed or (on a
   * connection that reads through a scope check) an edit was queued since it was fetched, the
   * connection moved the revision otherwise since its fetch began (a comment write applied, a
   * write marker deleted), no read that used it was authorized, a batch was already built from
   * it (`spendCopy`), or its revision was returned longer ago than a write may be pinned to it
   * (`docRevisionPins`). Asks Google nothing. Read the tabs wanted from it before awaiting
   * anything.
   */
  heldCopy(): GoogleDocSnapshot | undefined;
  /**
   * Records that a batch built from `copy`, which `heldCopy()` answered, is about to be sent.
   * A copy builds one batch: whatever becomes of it, `heldCopy()` does not answer that copy
   * again for as long as the host remembers this, so a retry of a batch that did not land
   * reads the document. A host may keep it in memory: one that forgot answers the copy once
   * more, and the pin to its revision keeps that write safe. Reads are not affected.
   */
  spendCopy(copy: GoogleDocSnapshot): void;
  /**
   * Stores `document`, which `api.getDocument` has just answered, as it is read, runs `use`
   * over its copy, and keeps nothing of it (`DocStore.trial`): synchronous, in the one stretch
   * the copy is valid for. `document` is emptied as it is read. For the write an approval
   * builds from the document as it is at Google when the stored copy cannot say.
   * @throws Before `use` is called, what storing the document throws: `DocRowTooLargeError`
   * and a `TypeError` or an `Error` for an answer the copy cannot keep (faults of what can be
   * stored), and `DocRunRenderError` where the renderer throws on a run (a fault of the
   * document). Nothing of the document is stored then, and the stored copy is as it was.
   */
  tryFetched<T>(document: GoogleDocsDocument, use: (copy: DocCopy) => T): T;
};

/**
 * Deletes the marker of a write a receipt still names, if it is in `document`, and answers the
 * document read again without it.
 */
async function reconcileDocWriteReceipt(
  host: DocHost, document: GoogleDocsDocument,
): Promise<GoogleDocsDocument> {
  let receipt = host.receipt();
  if (!receipt) return document;

  // The marker ID is exact, but its tab is not recorded, so every tab is searched for it.
  let markerTab = document.tabs.find(
    tab => googleDocNamedRanges(tab).some(({ id }) => id === receipt.markerId),
  );
  if (!markerTab) {
    host.clearReceipt(receipt.markerId);
    return document;
  }

  await host.api.deleteNamedRange(host.documentId, receipt.markerId, markerTab.tabId);
  host.clearReceipt(receipt.markerId);
  return host.api.getDocument(host.documentId);
}

/** Thrown to undo the transaction `checkedEditRequests` runs in. */
const CHECKED = new Error("undone: an approval's check keeps nothing");

/**
 * The requests of `edit` in `version`, made by `docEditResult` and so held to every check a
 * replay makes of the version they give, a paragraph or a table grown past a row among them, in
 * a transaction that is undone: an approval stores nothing of the check.
 * @throws What `docEditResult` throws: `DocEditRefusedError` for an edit the version refuses,
 * and faults of storage.
 */
function checkedEditRequests(
  store: DocStore, version: DocVersion, edit: DocEdit,
): readonly GoogleDocsBatchRequest[] {
  let made: { requests: readonly GoogleDocsBatchRequest[] } | undefined;
  try {
    store.transaction(() => {
      made = { requests: docEditResult(store, version, edit).requests };
      throw CHECKED;
    });
  } catch (error) {
    if (error !== CHECKED) throw error;
  }
  return made!.requests;
}

/**
 * What the copy `held` says of `action`'s write: the marker of a write that already landed,
 * or the batch to send pinned to the copy's revision. `undefined` where the copy cannot say
 * and the document as it is then decides: no revision to pin the batch to, a tab the copy
 * lacks, cannot index or cannot read back, an edit the copy's tab refuses or that changes
 * nothing in it, or more than one marker of the write. The batch is the one a replay stored for
 * the edit in the tab's base version; where none is stored it is made as a replay makes it and
 * held to the same checks (`checkedEditRequests`), and nothing of that is kept.
 */
function planFromCopy(action: GoogleDocEditAction, held: GoogleDocSnapshot):
  | { landed: GoogleDocWriteMarker }
  | { write: MaterializedGoogleDocAction; revisionId: string }
  | undefined {
  let { revisionId, copy } = held;
  // A batch built from the copy never leaves unpinned: the pin is all that keeps a copy the
  // document has moved past from being written over it, and `batchUpdate` pins only to a
  // revision that is not empty.
  if (!revisionId) return undefined;
  try {
    let markers = new Map<string, GoogleDocWriteMarker>();
    for (let { tabId } of googleDocActionTabs([...copy.outline], action)) {
      let base = copy.tab(tabId);
      if (!base) return undefined;
      for (let marker of base.writeMarkers) {
        if (marker.writeId === action.writeId) markers.set(marker.id, { id: marker.id, tabId });
      }
    }
    if (markers.size > 1) return undefined;
    let [landed] = markers.values();
    if (landed) return { landed };

    // Before any stored result is looked up: a record written under an earlier Markdown
    // version is never sent from a result stored for it.
    assertDocEditReplayable(action);
    let base = copy.tab(docEditTab(copy.outline, action).tabId);
    let { store } = storedIn(copy);
    if (!base || store.unindexed(base)) return undefined;
    // The requests a replay stored for the edit; otherwise made as a replay makes them.
    let stored = store.result(base, docEditKey(action));
    if (stored && "refusal" in stored) return undefined;
    let requests = stored?.requests ?? checkedEditRequests(store, base, action);
    return requests.length > 0 ? { write: { tab: base, requests }, revisionId } : undefined;
  } catch {
    // A tab that cannot be read back, or an edit the copy's tab refuses, a batch that leaves
    // the piece it was built from among them.
    return undefined;
  }
}

/**
 * The id of the tab the edit `action` is made in, among `tabs`, with the edit's own refusals:
 * `assertDocEditReplayable` and `docEditTab`, which read the tabs' identities alone.
 * It answers the id and nothing else, and is a function of its own, so that no frame names the
 * tab as Google sent it while the document is stored: a tab named there would hold its whole
 * body for the length of the trial.
 * @throws For an edit that no longer replays, or whose tab `tabs` does not hold.
 */
function editTabId(tabs: readonly { tabId: string }[], action: GoogleDocEditAction): string {
  assertDocEditReplayable(action);
  return docEditTab(tabs, action).tabId;
}

/**
 * The write of the edit `action`, built from `document`, just fetched, as the store holds it.
 * An edit that no longer replays, or whose tab the document does not hold, is refused first,
 * from the tab identities in hand and with nothing stored; otherwise the document is stored
 * as it is read, in a trial, and the edit is made in its tab of that copy as a replay makes it
 * and held to the same checks (`checkedEditRequests`). Synchronous.
 * @returns The write, or `refused`: the edit's own refusals and the replay's
 * (`DocEditRefusedError`: the builders', the model's, a version with an element too large for a
 * row), or, for a run the renderer threw on while the document was stored, what the renderer
 * threw.
 * @throws What cannot be stored (`DocHost.tryFetched`, but for `DocRunRenderError`) and a copy
 * that does not read back (`DOC_COPY_UNREADABLE`): faults that fail the approval and leave the
 * edit pending, since approving again may find them mended and no edit may be failed for good
 * by a fault of storing.
 */
function fetchedEdit(
  host: DocHost, document: GoogleDocsDocument, action: GoogleDocEditAction,
): { readonly write: MaterializedGoogleDocAction } | { readonly refused: unknown } {
  let tabId: string;
  try {
    tabId = editTabId(document.tabs, action);
  } catch (error) {
    return { refused: error };
  }
  try {
    return host.tryFetched(document, copy => unwrapped(() => {
      let base = copy.tab(tabId);
      if (!base) throw new Error(DOC_COPY_UNREADABLE);
      try {
        return { write: { tab: base, requests: checkedEditRequests(storedIn(copy).store, base, action) } };
      } catch (error) {
        // Anything else is a fault of storage, not of the edit, and passes as storage threw it
        // (`unwrapped`).
        if (error instanceof DocEditRefusedError) return { refused: error };
        throw error;
      }
    }));
  } catch (error) {
    if (!(error instanceof DocRunRenderError)) throw error;
    // The renderer's own throw, whose message is the reason the edit is recorded with. Storing
    // the document renders every run of it the stored copy does not hold rendered, in
    // whichever tab: a document the copy cannot render fails its reads too, and an edit left
    // pending for it would hold back the edits queued behind it for a fault no retry mends.
    return { refused: error.cause };
  }
}

/**
 * Writes `action`, edit `id`, unless its write already landed: one `batchUpdate` pinned to the
 * revision it was built against, carrying a named range that marks the write. An edit is built
 * from the copy the connection holds, when it holds one that can say, and the host is told so
 * that the copy builds no second batch; where Google refuses that batch, and wherever the copy
 * cannot say, the document is fetched: a receipt or a marker in it settles the edit, and
 * otherwise the document is stored as it is read, in a trial that keeps nothing, and the batch
 * is built from the edit's tab of that copy (`fetchedEdit`). A retry that finds its own marker,
 * or a receipt naming this edit, settles without writing again; a retry of an add that landed
 * without its reply is refused. The caller has given the edit a write ID.
 */
async function applyDocEdit(action: GoogleDocAction, host: DocHost, id: number): Promise<void> {
  let { api, documentId } = host;
  if (!action.writeId) throw new Error(`Google Doc action ${id} has no write ID`);
  let writeMarkerName = googleDocWriteMarkerName(action.writeId);
  // An add of a tab reads the document: its retry is checked against the tab tree as it is
  // then, and only Google's reply names the tab. So does an approval made while an earlier
  // write's marker is still to be deleted: deleting it moves the revision past the copy's.
  if (action.type !== "addTab" && !host.receipt()) {
    let held = host.heldCopy();
    let plan = held && planFromCopy(action, held);
    if (plan && "landed" in plan) {
      host.landed(id, plan.landed);
      return;
    }
    if (held && plan) {
      // Before the batch leaves: no outcome of it leaves a copy that builds the same batch
      // again, so an approval tried again reads the document.
      host.spendCopy(held);
      let { tab, requests } = plan.write;
      let result = await api.batchUpdate(documentId, requests, plan.revisionId, {
        name: writeMarkerName,
        rangeStart: tab.bodyEndIndex - 1,
        tabId: tab.tabId,
      }).catch((error: unknown) => {
        let failure = docsWriteFailure(error);
        // Nothing of the document, and not the caught value: the logger writes its message.
        logger.warn("Google Doc write built from the copy held was not accepted", {
          event: "google.doc.action.apply.copy-refused",
          actionId: id,
          operation: action.type,
          failure,
          providerStatus: error instanceof GoogleApiError ? error.providerStatus : undefined,
          // What the approval does next: reads the document now, or fails and reads it when
          // tried again.
          fallback: failure === "absent" ? "read" : "retry",
        });
        // Google answered and refused the batch whole, as it does once the document has moved
        // past the copy: the document is read below. Any other failure may have written.
        if (failure !== "absent") throw error;
        return undefined;
      });
      if (result) {
        if (!result.writeMarkerId) {
          throw new Error(`Google Docs did not return a write marker for action ${id}`);
        }
        host.landed(id, { id: result.writeMarkerId, tabId: tab.tabId });
        return;
      }
    }
  }
  let doc = await api.getDocument(documentId);
  // A receipt names this edit when its write landed and its record outlived the receipt: settled
  // from it, before any cleanup could delete the marker that proves it. Its tab is not recorded,
  // so the marker is looked for.
  let receipt = host.receipt();
  if (receipt?.actionId === id) {
    let markerTab = doc.tabs.find(
      tab => googleDocNamedRanges(tab).some(({ id: marker }) => marker === receipt.markerId));
    host.landed(id, markerTab && { id: receipt.markerId, tabId: markerTab.tabId });
    return;
  }
  doc = await reconcileDocWriteReceipt(host, doc);
  let markers = googleDocActionTabs(doc.tabs, action).flatMap(tab =>
    googleDocNamedRangeIds(tab, writeMarkerName).map(marker => ({ id: marker, tabId: tab.tabId })));
  if (new Set(markers.map(marker => marker.id)).size > 1) {
    throw new Error(`Google Docs returned multiple write markers for action ${id}`);
  }
  let [writeMarker] = markers;
  /** The ID of the tab an add made, which only Google's reply to it names. */
  let addedTabId: string | undefined;
  // A retry of an add that landed without its reply is refused, and one whose earlier send has
  // no known outcome and whose marker is gone (a top-level add's marker is in another tab, which
  // a collaborator may have deleted) is checked before it is sent again.
  if (action.type === "addTab" && (writeMarker || action.knownTabIds !== undefined)) {
    try {
      if (writeMarker) throw googleDocLostAddError(action);
      assertGoogleDocAddUnsent(doc.tabs, action);
    } catch (error) {
      await host.unapplyable(id, action,
        `Pending Google Doc tab add was refused: ${errorMessage(error)} ` +
        "Edits queued for it must be queued again for a tab listTabs() shows.");
      throw new ActionApplyError(errorMessage(error), { cause: error });
    }
  }
  if (!writeMarker) {
    // Read before the document is stored, which empties it.
    let revisionId = doc.revisionId;
    // Outside the `try`: what cannot be stored (an element past a row, one the copy refuses)
    // fails the approval, as a read of that document fails, and leaves the edit pending. Only
    // what the edit or the document refuses records it as unapplyable.
    let edit = action.type === "addTab" ? undefined : fetchedEdit(host, doc, action);
    let materialized: MaterializedGoogleDocAction;
    try {
      if (action.type === "addTab") {
        materialized = materializeGoogleDocAddTab(doc.tabs, action);
      } else if (edit && "write" in edit) {
        materialized = edit.write;
      } else {
        throw edit?.refused;
      }
    } catch (error) {
      // Recorded, not removed: later edits stop waiting behind it, and approving it again
      // repeats the reason rather than reporting success for a write that never happened.
      // First what the refusal is marked with, where it is: a batch that left the piece it
      // was built from, or a piece that could not be made (logged as a preparation logs a
      // fault of the model: the fallback is the edit prepared again on the document read).
      logModelRefusal(action.type, error);
      logger.error("Google Doc action cannot be applied", {
        event: "google.doc.action.apply.unapplyable",
        actionId: id, error,
      });
      await host.unapplyable(
        id, action, `Pending Google Doc edit could not be applied: ${errorMessage(error)}`);
      throw new ActionApplyError(errorMessage(error), { cause: error });
    }
    let { tab, requests } = materialized;
    if (action.type === "addTab") {
      action.knownTabIds = doc.tabs.map(({ tabId }) => tabId);
      host.saved(id, action);
    }
    if (requests.length > 0) {
      let result = await api.batchUpdate(documentId, requests, revisionId, {
        name: writeMarkerName,
        rangeStart: tab.bodyEndIndex - 1,
        tabId: tab.tabId,
      }).catch(async (error: unknown) => {
        if (action.type === "addTab" && docsWriteFailure(error) !== "unknown") {
          // Refused whole, so no tab was added, and a retry has nothing to look for.
          delete action.knownTabIds;
          host.saved(id, action);
        }
        throw await explainUnopenedFile("doc", error, () => host.mimeType());
      });
      if (!result.writeMarkerId) {
        throw new Error(`Google Docs did not return a write marker for action ${id}`);
      }
      writeMarker = { id: result.writeMarkerId, tabId: tab.tabId };
      if (action.type === "addTab") {
        // Applied, but unnamed: a retry finds the marker and refuses.
        addedTabId = googleDocReplyTabId(result.replies[0]);
        if (!addedTabId) {
          throw new Error(`Google Docs did not return the new tab's ID for action ${id}`);
        }
      }
    }
  }
  host.landed(id, writeMarker, action.type === "addTab" && addedTabId
    ? { provisionalTabId: action.provisionalTabId, tabId: addedTabId } : undefined);
}

/** An edit's card, built from what the edit and its display fields hold. */
export function describeDocEdit(action: GoogleDocAction): ActionPresentation {
  switch (action.type) {
    case "replaceText": {
      let display = requireDocDisplay(action.display);
      let { before, after } = display.context ?? { before: "", after: "" };
      let requested = before + action.newMarkdown + after;
      let rendered = display.rendered ?? requested;
      let syntax = action.inTable ? "html" as const : "markdown" as const;
      let description = buildDescription(display.prose ?? `Replace text in tab ${display.tab}.`)
        .verbatim("Old", before + action.oldMarkdown + after, syntax);
      if (requested !== rendered) description.verbatim("Requested New", requested, syntax);
      description.verbatim("New", rendered, syntax);
      return { title: "Edit Google Doc", ...description.finish(), implementsRevert: false };
    }
    case "appendText": {
      let display = requireDocDisplay(action.display);
      let resulting = display.rendered ?? canonicalizeMarkdownForWrite(action.markdown);
      let description =
        buildDescription(`Append content to the end of tab ${display.tab}.`);
      if (action.markdown === resulting) {
        description.verbatim("Content", resulting, "markdown");
      } else {
        description
          .verbatim("Requested", action.markdown, "markdown")
          .verbatim("Resulting", resulting, "markdown");
      }
      return { title: "Append to Google Doc", ...description.finish(), implementsRevert: false };
    }
    case "addTab": {
      let display = requireDocDisplay(action.display);
      let description = buildDescription(display.placement).inline("Title", action.title);
      return { title: "Add tab to Google Doc", ...description.finish(), implementsRevert: false };
    }
    default: {
      let display = requireDocDisplay(action.display);
      return { title: display.title, ...display.description, implementsRevert: false };
    }
  }
}

function requireDocDisplay<D>(display: D | undefined): D {
  if (!display) throw new Error("This Google Doc edit has no card to show.");
  return display;
}

/** The definitions of the Doc edits, by the type each stored edit names. */
export type GoogleDocEdits = { [T in GoogleDocAction["type"]]: Extract<GoogleDocAction, { type: T }> };

/**
 * One Doc edit's definition. No claim is taken: a write's marker goes up with its content, so an
 * approval cut off mid-write and tried again finds its own marker and settles without writing.
 */
function docEdit<A extends GoogleDocAction>(kind: ActionKind): ActionDefinition<A, DocHost> {
  return {
    kind,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: action => describeDocEdit(action),
    apply: (action, host, ctx) => applyDocEdit(action, host, ctx.id),
  };
}

/**
 * Each Doc edit's definition. Text edits are "Document edits", new tabs "New document tabs" and
 * every change to a table "Table changes"; a user may let each kind apply without asking.
 */
export const DOC_DEFINITIONS: { [T in keyof GoogleDocEdits]: ActionDefinition<GoogleDocEdits[T], DocHost> } = {
  replaceText: docEdit(EDIT_DOCUMENT_ACTION),
  appendText: docEdit(EDIT_DOCUMENT_ACTION),
  addTab: docEdit(ADD_DOCUMENT_TAB_ACTION),
  insertTable: docEdit(DOCUMENT_TABLES),
  insertTableRows: docEdit(DOCUMENT_TABLES),
  insertTableColumns: docEdit(DOCUMENT_TABLES),
  deleteTableRows: docEdit(DOCUMENT_TABLES),
  deleteTableColumns: docEdit(DOCUMENT_TABLES),
  deleteTable: docEdit(DOCUMENT_TABLES),
  setTableCellStyle: docEdit(DOCUMENT_TABLES),
  setTableColumnWidths: docEdit(DOCUMENT_TABLES),
  setTableRowHeights: docEdit(DOCUMENT_TABLES),
  mergeTableCells: docEdit(DOCUMENT_TABLES),
  unmergeTableCells: docEdit(DOCUMENT_TABLES),
};

/** The definition `action` is applied and described by. */
export function docDefinition(action: GoogleDocAction): ActionDefinition<GoogleDocAction, DocHost> {
  return DOC_DEFINITIONS[action.type] as ActionDefinition<GoogleDocAction, DocHost>;
}
