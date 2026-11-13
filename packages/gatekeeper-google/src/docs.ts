/**
 * The Google Docs gatekeeper: a directly bound Doc's editor and its session, and the session a
 * Google Drive binding opens a Doc with.
 */

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  GatekeeperUserVerifier, Gatekeeper, ResourceDescription, ApprovalQueue, ObservationDescription,
  ActionKind, GitCache,
} from '@gadgets/workshop-shared/gatekeeper';
import {
  ActionApplyError, ActionJournal, type ActionDefinition, type ActionPresentation,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline } from "@gadgets/gatekeeper-kit/action-description";
import {
  GoogleDocSession, DocMetadata, type DocCommentOptions, type DocSuggestEditOptions,
  type GoogleDocReadSession, type GoogleDocTab,
} from "./docs-types";
import {
  DOC_COMMENT_ACTIONS, DocCommentSession, docsThreads, type DocCommentQueue,
} from "./doc-comments";
import {
  BLANK_DOC_TAB_ID, BlankGoogleDoc, blankDocsTab, docsWriteFailure, GoogleDocsApi, type DocsBatchReply,
  type GoogleDocReader, type GoogleDocsDocument, type GoogleDocsTab,
} from "./docs-api";
import { checkDocTabTitle, insertDocTab, type DocTabPlacement } from "./docs-tabs";
import {
  boundProps, createFileOnce, isSimulated, UNCREATED_FILE_ID, type SimulatedFileProps,
} from "./creation";
import {
  applyMarkdownEdit, assertMarkdownWriteComplexity, canonicalizeMarkdownForWrite,
  canonicalizeMarkdownReplacement,
  computeReplaceOperations, docTabToMarkdown, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
  type DocTabSnapshot, type EditableMarkdown,
} from "./markdown-converter";
import { DriveApi, DriveApiRequestError } from "./drive-api";
import { type DriveCommentAction } from "./drive-comments";
import { writeAttempts } from "./drive-writes";
import { fileSubresourceId, requireFileSubresources } from "./file-subresources";
import { driveModifiedTime, type NativeObservation, type NativeRead } from "./drive-session";
import type { DocSuggestion, DriveComment, DriveCommentReply } from "./drive-types";
import { verifyGoogleSubresourceAccess, type GoogleVerifierApi } from "./google-verifier-types";
import DOCS_READ_TYPES_CODE from "./docs-read-types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import COMMENT_TYPES_CODE from "./comment-types.txt";
import { obsContext } from "./observability.js";
import { AccessTokenCache, AccessTokenRequest } from "./auth-retry";
import { Mutex } from "./mutex";
import { ReadGate } from "./read-gate";
import { nativeFileUrl } from "./resources";
import { explainUnopenedFile, officeFileError, officeLabel } from "./office-conversion";
import { DOCS_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";

import { PENDING_NEXT_ACTION_ID_KEY, PendingActionStore } from "./pending-actions";
import type { UserAccount } from "./google";

const logger = obsContext.createLogger({ component: "gatekeeper.google", vendorId: "google" });

type Env = Cloudflare.Env;

let googleDocTypesCode: string | undefined;

/**
 * A directly bound Doc's bundle. It holds the comment declarations, which every Drive bundle holds
 * too, so the vendor's bundle takes them from here and from no Drive part.
 */
export function getGoogleDocTypesCode(): string {
  return googleDocTypesCode ??= [
    DOCS_READ_TYPES_CODE, COMMENT_TYPES_CODE,
    stripTypeModulePrefix(DOCS_TYPES_CODE, DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

type GoogleDocActionBase = {
  submittedAt: number;
  baseRevisionId?: string;
  writeId?: string;
  invalidatedReason?: string;
  /** The Markdown version the edit was previewed under. */
  markdownVersion?: number;
}

/** What an edit's card shows beyond the edit itself, recorded with it since a card is built from the record. */
type GoogleDocEditDisplay = {
  /** The tab's label, as the card names it. */
  tab: string;
  /** The replacement's text as it is written, where it differs from the text asked for. */
  rendered?: string;
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

type GoogleDocReplaceAction = GoogleDocEditBase & {
  type: "replaceText";
  oldMarkdown: string;
  newMarkdown: string;
}

type GoogleDocAppendAction = GoogleDocEditBase & {
  type: "appendText";
  markdown: string;
}

/** A new, empty tab, placed under `parentTabId` at `index` as `addDocumentTab` places it. */
type GoogleDocAddTabAction = GoogleDocActionBase & DocTabPlacement & {
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

type GoogleDocEditAction = GoogleDocReplaceAction | GoogleDocAppendAction;
type GoogleDocAction = GoogleDocEditAction | GoogleDocAddTabAction;

const DOC_WRITE_RECEIPT_KEY = "docWriteReceipt";
const DOC_METADATA_REVISION_KEY = "docMetadataRevision";
/** The last document read, replayed for this long before its revision is rechecked. */
const DOC_SNAPSHOT_TTL_MS = 10_000;
/** The last document read. Pending actions overlay it, so it outlives none. */
const DOC_SNAPSHOT_KEY = "docSnapshot";
/** Name prefix of the named range that marks one Gadgets write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";
/** Prefix of the ID `addTab()` returns for a tab Google has not added yet. */
const PROVISIONAL_TAB_PREFIX = "pending-tab-";
/** Each added tab's provisional ID to the ID Google gave it, oldest first. */
const DOC_ADDED_TABS_KEY = "docAddedTabs";
/** How many added tabs' provisional IDs keep resolving after their adds apply. */
const MAX_DOC_ADDED_TABS = 100;

type GoogleDocWriteReceipt = { actionId: number; markerId: string };

/** The document revision this binding has already reported, and when it first saw it. */
type GoogleDocMetadataRevision = { revisionId?: string; observedAt: number };
type GoogleDocNamedRange = { id: string; name: string };

function googleDocNamedRanges(tab: GoogleDocsTab): GoogleDocNamedRange[] {
  let result: GoogleDocNamedRange[] = [];
  for (const [fallbackName, collection] of Object.entries<unknown>(tab.namedRanges)) {
    if (!collection || typeof collection !== "object") {
      throw new Error("Google Docs returned invalid named ranges");
    }
    let ranges = (collection as { namedRanges?: unknown }).namedRanges;
    if (!Array.isArray(ranges)) {
      throw new Error("Google Docs returned invalid named ranges");
    }
    for (const range of ranges) {
      if (!range || typeof range !== "object") {
        throw new Error("Google Docs returned an invalid named range");
      }
      let {namedRangeId, name} = range as { namedRangeId?: unknown; name?: unknown };
      if (typeof namedRangeId !== "string" || namedRangeId.length === 0 ||
          (name !== undefined && typeof name !== "string")) {
        throw new Error("Google Docs returned an invalid named range");
      }
      result.push({ id: namedRangeId, name: name ?? fallbackName });
    }
  }
  return result;
}

function googleDocNamedRangeIds(tab: GoogleDocsTab, name: string): string[] {
  let ids = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name === name) ids.add(range.id);
  }
  return [...ids];
}

/** The named range that marks one write, named so the write is recognizable on a retry. */
function googleDocWriteMarkerName(writeId: string): string {
  return `${WRITE_MARKER_PREFIX}${writeId}`;
}

/**
 * The write IDs whose content `tab` already contains.
 *
 * A marker and its content go up in one atomic batch, so a marker naming a write ID proves that
 * write committed — including the case where its response was lost and its action is still
 * pending. Simulating such an action over this tab would show its content twice.
 */
function googleDocCommittedWriteIds(tab: GoogleDocsTab): string[] {
  let writeIds = new Set<string>();
  for (let range of googleDocNamedRanges(tab)) {
    if (range.name.startsWith(WRITE_MARKER_PREFIX)) {
      writeIds.add(range.name.slice(WRITE_MARKER_PREFIX.length));
    }
  }
  return [...writeIds];
}

/** One tab's Markdown rendering, tagged with the writes that tab already contains. */
type GoogleDocTabSnapshot = DocTabSnapshot & { committedWriteIds: string[] };

/** A whole document as this gatekeeper caches it: one independent rendering per tab. */
type GoogleDocSnapshot = {
  /** Rendering schema of `tabs`; bumped by the converter that produced them. */
  formatVersion: typeof MARKDOWN_RENDERING_VERSION;
  title: string;
  /** Absent unless the caller can edit the document; see `GoogleDocsDocument.revisionId`. */
  revisionId?: string;
  tabs: GoogleDocTabSnapshot[];
  /** `Date.now()` at the time of fetch, used for TTL checks. */
  fetchedAt: number;
}

function googleDocSnapshot(document: GoogleDocsDocument): GoogleDocSnapshot {
  return {
    formatVersion: MARKDOWN_RENDERING_VERSION,
    title: document.title,
    revisionId: document.revisionId,
    tabs: document.tabs.map(tab => ({
      ...docTabToMarkdown(tab),
      committedWriteIds: googleDocCommittedWriteIds(tab),
    })),
    fetchedAt: Date.now(),
  };
}

/** Accept a cached snapshot only if it predates nothing this code depends on. */
function isGoogleDocSnapshot(value: unknown): value is GoogleDocSnapshot {
  if (!value || typeof value !== "object") return false;
  let {formatVersion, title, tabs, revisionId, fetchedAt} = value as Partial<GoogleDocSnapshot>;
  return formatVersion === MARKDOWN_RENDERING_VERSION && typeof title === "string" &&
      Array.isArray(tabs) && (revisionId === undefined || typeof revisionId === "string") &&
      typeof fetchedAt === "number" && Number.isFinite(fetchedAt);
}

/**
 * Whether an expired snapshot still describes the current document.
 *
 * Google withholds `revisionId` from a caller without edit access, leaving no change token, so
 * such a document is refetched rather than spending a request on an answer that could never
 * confirm the cache.
 */
async function googleDocRevisionUnchanged(
  docsApi: GoogleDocReader,
  documentId: string,
  cached: GoogleDocSnapshot,
): Promise<boolean> {
  return cached.revisionId !== undefined &&
      await docsApi.getRevisionId(documentId) === cached.revisionId;
}

/**
 * The tab an operation names, or a failure telling the agent how to name one.
 *
 * Omission is resolved from the flattened tab list, so a single root with any child counts as
 * multi-tab. An unknown ID never falls back to the first tab: the caller meant a specific one.
 */
function resolveGoogleDocTab(
  snapshot: GoogleDocSnapshot,
  tabId: string | undefined,
  operation: "getContent" | "replaceText" | "appendText",
): GoogleDocTabSnapshot {
  if (tabId === undefined) {
    if (snapshot.tabs.length !== 1) {
      throw new Error(
        `${operation}: tabId is required for documents with multiple tabs. ` +
        `Call listTabs() to choose a tab.`);
    }
    return snapshot.tabs[0];
  }
  let tab = snapshot.tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(
      `${operation}: no tab with ID "${tabId}" exists in this document. ` +
      `Call listTabs() to refresh the tab list.`);
  }
  return tab;
}

/** The agent-facing view of one tab: identity and position, never content. */
function googleDocTabMetadata(tab: DocTabSnapshot): GoogleDocTab {
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
function googleDocTabLabel(tab: DocTabSnapshot): string {
  let id = tab.tabId.startsWith(PROVISIONAL_TAB_PREFIX) ? "new tab" : tab.tabId;
  return `"${plainInline(tab.title)}" (${id})`;
}

function parseGoogleDocWriteReceipt(value: unknown): GoogleDocWriteReceipt | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  let { actionId, markerId } = value as { actionId?: unknown; markerId?: unknown };
  if (typeof actionId !== "number" || !Number.isSafeInteger(actionId) || actionId < 1 ||
      typeof markerId !== "string" || markerId.length === 0) {
    throw new Error("Stored Google Doc write receipt is invalid");
  }
  return { actionId, markerId };
}

type GoogleDocPendingAction = { id: number; action: GoogleDocAction };

type GoogleDocSimulatedContent = EditableMarkdown & {
  /** The valid document insertion point for an append, absent after trailing structure. */
  appendIndex: number | undefined;
};

function googleDocAppendIndex(tab: GoogleDocTabSnapshot): number | undefined {
  return tab.sourceMap.blocks.at(-1)?.docEnd === tab.bodyEndIndex
    ? tab.bodyEndIndex - 1
    : undefined;
}

function requireGoogleDocAppendIndex(appendIndex: number | undefined): number {
  if (appendIndex === undefined) {
    throw new Error(
      "appendText: the selected tab does not end in a paragraph. " +
      "Add a paragraph after its final table or structural element and retry.",
    );
  }
  return appendIndex;
}

function googleDocSimulatedContent(tab: GoogleDocTabSnapshot): GoogleDocSimulatedContent {
  return {
    markdown: tab.markdown,
    protectedRanges: tab.sourceMap.protectedRanges,
    appendIndex: googleDocAppendIndex(tab),
  };
}

/** A tab `addTab()` queued, rendered as Google adds it: empty. */
function newGoogleDocTab(
  { provisionalTabId, title }: Pick<GoogleDocAddTabAction, "provisionalTabId" | "title">,
): GoogleDocTabSnapshot {
  return { ...docTabToMarkdown(blankDocsTab(provisionalTabId, title)), committedWriteIds: [] };
}

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
function assertGoogleDocAddUnsent(tabs: DocTabSnapshot[], action: GoogleDocAddTabAction): void {
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
function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string): string;
function adoptedGoogleDocTabId(
  kv: DurableObjectStorage["kv"], tabId: string | undefined,
): string | undefined;
function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string | undefined) {
  if (!tabId?.startsWith(PROVISIONAL_TAB_PREFIX)) return tabId;
  return kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY)?.[tabId] ?? tabId;
}

/** The document as the pending queue leaves it. */
type GoogleDocSimulation = {
  /** Every tab, those queued with `addTab()` included, flattened as Google flattens them. */
  tabs: GoogleDocTabSnapshot[];
  /** The simulated content of every tab, since one replay covers them all. */
  contentByTabId: Map<string, GoogleDocSimulatedContent>;
}

/** One replay of the pending queue, keyed by the state it was computed from. */
type GoogleDocSimulatedContentCache = {
  baseRevisionId?: string;
  pendingFingerprint: string;
  simulation: GoogleDocSimulation;
}

type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
  /** Writes landed in the document, counted so a read awaiting Google across one can tell. */
  writes: number;
}

function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

const MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES = 1024 * 1024;
const googleDocActionEncoder = new TextEncoder();

function assertGoogleDocActionMarkdownSize(...values: string[]): void {
  // UTF-16 length is a lower bound on UTF-8 bytes, so an oversized input is refused unencoded.
  let byteLength = values.reduce((total, value) => total + value.length, 0);
  if (byteLength <= MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    byteLength = values.reduce(
      (total, value) => total + googleDocActionEncoder.encode(value).byteLength, 0);
  }
  if (byteLength > MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES) {
    throw new Error(
      `Google Doc action Markdown exceeds the ${MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES}-byte ` +
      "safe submission limit.",
    );
  }
  for (let value of values) assertMarkdownWriteComplexity(value);
}
function findUniqueMarkdown(
  markdown: string,
  oldMarkdown: string,
  operation: string,
  tabId: string,
): number {
  if (oldMarkdown.length === 0) {
    throw new Error(`${operation}: oldMarkdown must not be empty.`);
  }

  let index = markdown.indexOf(oldMarkdown);
  if (index === -1) {
    throw new Error(
      `${operation}: oldMarkdown was not found in the current simulated tab "${tabId}". ` +
      `Make sure the text exactly matches content returned by getContent("${tabId}").`);
  }

  let secondIndex = markdown.indexOf(oldMarkdown, index + 1);
  if (secondIndex !== -1) {
    throw new Error(
      `${operation}: oldMarkdown matches multiple locations in the current simulated tab ` +
      `"${tabId}". Include more surrounding context to make the match unique.`);
  }

  return index;
}

function applyMarkdownReplacement(
  content: GoogleDocSimulatedContent,
  action: GoogleDocReplaceAction,
  tabId: string,
): GoogleDocSimulatedContent {
  let { oldMarkdown } = action;
  let newMarkdown = canonicalizeMarkdownReplacement(oldMarkdown, action.newMarkdown);
  let start = findUniqueMarkdown(content.markdown, oldMarkdown, "replaceText", tabId);
  if (oldMarkdown === newMarkdown) return content;
  return {
    ...content,
    ...applyMarkdownEdit(content, start, start + oldMarkdown.length, newMarkdown),
  };
}

/**
 * Whether a tab holds nothing but one empty paragraph, as a new document does. An append fills
 * that paragraph rather than following it, in both the simulation and the write. A paragraph whose
 * only content renders as nothing (a chip with no label) is protected, so it is not blank. Empty
 * Markdown counts too: a pending replace that removes a tab's whole content leaves the simulation
 * empty, while the real tab keeps its final paragraph and so renders as `"\n"`.
 */
function isBlankGoogleDocTab({ markdown, protectedRanges }: EditableMarkdown): boolean {
  return (markdown === "" || markdown === "\n") && protectedRanges.length === 0;
}

function appendMarkdownForSimulation(content: EditableMarkdown, appendedMarkdown: string): string {
  let terminatedAppend = appendedMarkdown + "\n";

  if (isBlankGoogleDocTab(content)) return terminatedAppend;
  let { markdown } = content;
  return canonicalizeMarkdownReplacement(
    markdown, markdown + (markdown.endsWith("\n") ? "\n" : "\n\n") + terminatedAppend);
}

function assertGoogleDocActionReplayable(action: GoogleDocAction): void {
  if (action.invalidatedReason) throw new Error(action.invalidatedReason);
  // A new tab holds no Markdown, so no rendering change can alter it.
  if (action.type !== "addTab" && action.markdownVersion !== MARKDOWN_RENDERING_VERSION) {
    throw new Error(
      "Pending Google Doc edit was queued under an earlier Markdown format and may no longer " +
      "apply as previewed. Reject it and retry.");
  }
}

function applyGoogleDocActionToContent(
  content: GoogleDocSimulatedContent,
  action: GoogleDocEditAction,
  tabId: string,
): GoogleDocSimulatedContent {
  assertGoogleDocActionReplayable(action);

  switch (action.type) {
    case "replaceText":
      return applyMarkdownReplacement(content, action, tabId);
    case "appendText":
      requireGoogleDocAppendIndex(content.appendIndex);
      return {
        ...content,
        markdown: appendMarkdownForSimulation(
          content, canonicalizeMarkdownForWrite(action.markdown)),
      };
    default:
      action satisfies never;
      throw new Error("unknown Google Doc action type");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidateGoogleDocAction(
  pendingActions: PendingActionStore<GoogleDocAction>,
  pending: GoogleDocPendingAction,
  reason: string,
): void {
  if (!pending.action.invalidatedReason) {
    pending.action.invalidatedReason = reason;
    pendingActions.put(pending.id, pending.action);
  }
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

/** Whether `snapshot` already holds `action`'s write, which landed though its reply was lost. */
function googleDocActionCommitted(snapshot: GoogleDocSnapshot, action: GoogleDocAction): boolean {
  let { writeId } = action;
  return writeId !== undefined && googleDocActionTabs(snapshot.tabs, action)
    .some(tab => tab.committedWriteIds.includes(writeId));
}

/**
 * The tab an edit targets.
 *
 * A record stored before tabs were addressable names none, but the old code refused to read a
 * document with more than one tab, so such a record was approved against a document that had
 * exactly one. A document still holding one tab therefore resolves unambiguously; tabs added
 * since leave the approved target unknowable.
 *
 * Exported for coverage: no current write path can produce such a record.
 */
export function googleDocActionTab(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocEditAction,
): GoogleDocTabSnapshot {
  if (action.tabId === undefined && snapshot.tabs.length !== 1) {
    throw new Error(
      "Pending Google Doc edit predates tab support and the document has gained tabs since, " +
      "so the tab it was approved against is unknown. Reject it and retry on a selected tab.");
  }
  return resolveGoogleDocTab(snapshot, action.tabId, action.type);
}

/**
 * Replay the pending queue over `snapshot`, invalidating any action that no longer applies.
 *
 * Actions are replayed in global approval order, but each edit only touches its own tab, so an
 * edit to one tab can neither shift nor be shifted by an edit to another. An added tab joins the
 * tab list where Google will put it, and edits queued for it then find it there.
 *
 * An edit whose marker `snapshot` already holds committed though its reply never arrived, so
 * the snapshot contains it, and replaying it would show its content twice; it stays pending, and
 * applyAction() settles it from the same marker. An add whose marker the snapshot holds is still
 * replayed as pending, though the tab it made is in the snapshot too: its reply may yet arrive,
 * to an approval still running, and only applyAction() can tell it was lost.
 */
function invalidateUnreplayableGoogleDocActions(
  pendingActions: PendingActionStore<GoogleDocAction>,
  snapshot: GoogleDocSnapshot,
  pending: GoogleDocPendingAction[],
  context: string,
): GoogleDocSimulation {
  let tabs = snapshot.tabs;
  let contentByTabId = new Map(
    snapshot.tabs.map(tab => [tab.tabId, googleDocSimulatedContent(tab)]),
  );
  for (let record of pending) {
    let { action } = record;
    if (action.invalidatedReason) continue;

    try {
      if (action.type === "addTab") {
        assertGoogleDocActionReplayable(action);
        let tab = newGoogleDocTab(action);
        tabs = insertDocTab(tabs, tab, { parentTabId: action.parentTabId, index: action.index });
        contentByTabId.set(tab.tabId, googleDocSimulatedContent(tab));
        continue;
      }
      if (googleDocActionCommitted(snapshot, action)) continue;
      let { tabId } = googleDocActionTab({ ...snapshot, tabs }, action);
      contentByTabId.set(
        tabId,
        applyGoogleDocActionToContent(contentByTabId.get(tabId)!, action, tabId),
      );
    } catch (error) {
      invalidateGoogleDocAction(
        pendingActions,
        record,
        `${context}: ${errorMessage(error)} This edit was dropped from the document. ` +
        `Reject it and retry if it is still needed.`,
      );
    }
  }

  return { tabs, contentByTabId };
}

/** The batch requests for one edit, together with the tab they are addressed to. */
function materializeGoogleDocAction(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocAction,
): { tab: GoogleDocTabSnapshot; requests: any[] } {
  assertGoogleDocActionReplayable(action);
  if (action.type === "addTab") return materializeGoogleDocAddTab(snapshot, action);
  let tab = googleDocActionTab(snapshot, action);

  switch (action.type) {
    case "replaceText": {
      let matchStart = findUniqueMarkdown(
          tab.markdown, action.oldMarkdown, "applyAction(replaceText)", tab.tabId);
      let { requests } = computeReplaceOperations(
          tab.sourceMap,
          tab.markdown,
          matchStart,
          matchStart + action.oldMarkdown.length,
          canonicalizeMarkdownReplacement(action.oldMarkdown, action.newMarkdown),
          tab.tabId);
      return { tab, requests };
    }

    case "appendText": {
      let appendIndex = requireGoogleDocAppendIndex(googleDocAppendIndex(tab));
      let requests = isBlankGoogleDocTab(googleDocSimulatedContent(tab))
        ? markdownToDocRequests(action.markdown, appendIndex, tab.tabId, { resetParagraphs: true })
        : markdownToDocRequests("\n" + action.markdown, appendIndex, tab.tabId,
          { resetParagraphs: true, preserveLeadingParagraph: true });
      return { tab, requests };
    }

    default:
      action satisfies never;
      throw new Error(`unknown action type: ${(action as any).type}`);
  }
}

/**
 * The request adding a tab, refused where Google would refuse it. Its write marker goes in a tab
 * that exists: its parent, or the first tab.
 */
function materializeGoogleDocAddTab(
  snapshot: GoogleDocSnapshot,
  action: GoogleDocAddTabAction,
): { tab: GoogleDocTabSnapshot; requests: any[] } {
  let { title, parentTabId, index } = action;
  insertDocTab(snapshot.tabs, newGoogleDocTab(action), { parentTabId, index });
  let tab = snapshot.tabs.find(candidate => candidate.tabId === parentTabId) ?? snapshot.tabs[0];
  let tabProperties = {
    title,
    ...parentTabId === undefined ? {} : { parentTabId },
    ...index === undefined ? {} : { index },
  };
  return { tab, requests: [{ addDocumentTab: { tabProperties } }] };
}

export type GoogleDocGatekeeperImplProps =
  { userObjectId: string; documentId: string } | SimulatedFileProps;

/** The ID of the first tab of a document just created, for the real class to adopt pending edits. */
const CREATED_DOC_TAB_KEY = "createdDocTab";

/** Points every pending action naming tab `from`, as its target or as its parent, at tab `to`. */
function retargetGoogleDocActions(kv: DurableObjectStorage["kv"], from: string, to: string): void {
  let pendingActions = new PendingActionStore<GoogleDocAction>(kv);
  for (let { id, action } of pendingActions.list()) {
    if (action.type === "addTab") {
      if (action.parentTabId === from) pendingActions.put(id, { ...action, parentTabId: to });
    } else if (action.tabId === from) {
      pendingActions.put(id, { ...action, tabId: to });
    }
  }
}

/**
 * Hands the tab an add made from its provisional ID to the ID Google gave it: the actions queued
 * for it name Google's from now on, and the pair is kept, so an agent still holding the
 * provisional ID keeps reaching the tab.
 */
function adoptGoogleDocTab(
  kv: DurableObjectStorage["kv"], provisionalTabId: string, tabId: string,
): void {
  retargetGoogleDocActions(kv, provisionalTabId, tabId);
  let added = Object.entries(kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY) ?? {});
  kv.put(DOC_ADDED_TABS_KEY,
    Object.fromEntries([...added, [provisionalTabId, tabId]].slice(-MAX_DOC_ADDED_TABS)));
}

/**
 * Moves the state a simulated document left in storage onto the created one: pending actions
 * naming the blank document's tab name the created document's first tab, and the cached reads of
 * the blank document are dropped.
 */
function adoptBlankDocument(kv: DurableObjectStorage["kv"], tabId: string): void {
  retargetGoogleDocActions(kv, BLANK_DOC_TAB_ID, tabId);
  kv.delete(DOC_SNAPSHOT_KEY);
  kv.delete(DOC_METADATA_REVISION_KEY);
  kv.delete(CREATED_DOC_TAB_KEY);
}

// All Google Doc edits (replaceText, appendText, ...) are grouped under a single action kind
const EDIT_DOCUMENT_ACTION: ActionKind = {
  tag: "editDocument",
  label: "Document edits",
};

/** New tabs, a kind of their own since edits already have an auto-approvable one. */
const ADD_DOCUMENT_TAB_ACTION: ActionKind = {
  tag: "addDocumentTab",
  label: "New document tabs",
};

/** A write's marker, found with the tab it is in, which deleting it must name. */
type GoogleDocWriteMarker = { id: string; tabId: string };

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
   * no request, the document as read before it landed, and for an add, the tab it made.
   */
  landed(
    id: number, marker: GoogleDocWriteMarker | undefined, snapshot: GoogleDocSnapshot,
    addedTab?: { provisionalTabId: string; tabId: string },
  ): void;
  /**
   * Records that `action`, edit `id`, can no longer be applied, for `reason`, read over
   * `snapshot`.
   */
  unapplyable(
    id: number, action: GoogleDocAction, reason: string, snapshot: GoogleDocSnapshot,
  ): Promise<void>;
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

/**
 * Writes `action`, edit `id`, unless its write already landed: one `batchUpdate` built against a
 * fresh read, pinned to that read's revision, carrying a named range that marks the write. A
 * retry that finds its own marker, or a receipt naming this edit, settles without writing again;
 * a retry of an add that landed without its reply is refused. The caller has given the edit a
 * write ID.
 */
async function applyDocEdit(action: GoogleDocAction, host: DocHost, id: number): Promise<void> {
  let { api, documentId } = host;
  if (!action.writeId) throw new Error(`Google Doc action ${id} has no write ID`);
  let writeMarkerName = googleDocWriteMarkerName(action.writeId);
  let doc = await api.getDocument(documentId);
  // A receipt names this edit when its write landed and its record outlived the receipt: settled
  // from it, before any cleanup could delete the marker that proves it. Its tab is not recorded,
  // so the marker is looked for.
  let receipt = host.receipt();
  if (receipt?.actionId === id) {
    let markerTab = doc.tabs.find(
      tab => googleDocNamedRanges(tab).some(({ id: marker }) => marker === receipt.markerId));
    host.landed(id, markerTab && { id: receipt.markerId, tabId: markerTab.tabId },
      googleDocSnapshot(doc));
    return;
  }
  doc = await reconcileDocWriteReceipt(host, doc);
  let snapshot = googleDocSnapshot(doc);
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
      assertGoogleDocAddUnsent(snapshot.tabs, action);
    } catch (error) {
      await host.unapplyable(id, action,
        `Pending Google Doc tab add was refused: ${errorMessage(error)} ` +
        "Edits queued for it must be queued again for a tab listTabs() shows.", snapshot);
      throw new ActionApplyError(errorMessage(error), { cause: error });
    }
  }
  if (!writeMarker) {
    let materialized: { tab: GoogleDocTabSnapshot; requests: any[] };
    try {
      materialized = materializeGoogleDocAction(snapshot, action);
    } catch (error) {
      // Recorded, not removed: later edits stop waiting behind it, and approving it again
      // repeats the reason rather than reporting success for a write that never happened.
      logger.error("Google Doc action cannot be applied", {
        event: "google.doc.action.apply.unapplyable",
        actionId: id, error,
      });
      await host.unapplyable(
        id, action, `Pending Google Doc edit could not be applied: ${errorMessage(error)}`, snapshot);
      throw new ActionApplyError(errorMessage(error), { cause: error });
    }
    let { tab, requests } = materialized;
    if (action.type === "addTab") {
      action.knownTabIds = doc.tabs.map(({ tabId }) => tabId);
      host.saved(id, action);
    }
    if (requests.length > 0) {
      let result = await api.batchUpdate(documentId, requests, snapshot.revisionId, {
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
  host.landed(id, writeMarker, snapshot, action.type === "addTab" && addedTabId
    ? { provisionalTabId: action.provisionalTabId, tabId: addedTabId } : undefined);
}

/** An edit's card, built from what the edit and its display fields hold. */
function describeDocEdit(action: GoogleDocAction): ActionPresentation {
  switch (action.type) {
    case "replaceText": {
      let display = requireDocDisplay(action.display);
      let rendered = display.rendered ?? action.newMarkdown;
      let description = buildDescription(`Replace text in tab ${display.tab}.`)
        .verbatim("Old", action.oldMarkdown, "markdown");
      if (rendered !== action.newMarkdown) {
        description.verbatim("Requested New", action.newMarkdown, "markdown");
      }
      description.verbatim("New", rendered, "markdown");
      return { title: "Edit Google Doc", ...description.finish(), implementsRevert: false };
    }
    case "appendText": {
      let display = requireDocDisplay(action.display);
      let renderedMarkdown = canonicalizeMarkdownForWrite(action.markdown);
      let description =
        buildDescription(`Append content to the end of tab ${display.tab}.`);
      if (action.markdown === renderedMarkdown) {
        description.verbatim("Content", renderedMarkdown, "markdown");
      } else {
        description
          .verbatim("Requested", action.markdown, "markdown")
          .verbatim("Resulting", renderedMarkdown, "markdown");
      }
      return { title: "Append to Google Doc", ...description.finish(), implementsRevert: false };
    }
    case "addTab": {
      let display = requireDocDisplay(action.display);
      let description = buildDescription(display.placement).inline("Title", action.title);
      return { title: "Add tab to Google Doc", ...description.finish(), implementsRevert: false };
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
 * Each Doc edit's definition. Text edits are "Document edits", and new tabs "New document tabs";
 * a user may let both apply without asking.
 */
export const DOC_DEFINITIONS: { [T in keyof GoogleDocEdits]: ActionDefinition<GoogleDocEdits[T], DocHost> } = {
  replaceText: docEdit(EDIT_DOCUMENT_ACTION),
  appendText: docEdit(EDIT_DOCUMENT_ACTION),
  addTab: docEdit(ADD_DOCUMENT_TAB_ACTION),
};

/** The definition `action` is applied and described by. */
function docDefinition(action: GoogleDocAction): ActionDefinition<GoogleDocAction, DocHost> {
  return DOC_DEFINITIONS[action.type] as ActionDefinition<GoogleDocAction, DocHost>;
}

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #simulationCache: GoogleDocSimulationCacheHolder = { writes: 0 };

  // Serialize applying and rejecting actions, and creating the document, against each other. Every
  // network await below leaves the Durable Object's input gate open, and one action id can arrive
  // twice — the overseer marks a record approved only after applyAction() returns, so two approvals
  // of it both see it pending. Interleaved, both fetch the document and the loser writes content the
  // winner already committed; the write marker is no defence, since the winner's cleanup deletes it
  // before the loser looks. Two approvals of a creation would likewise create two documents.
  #actions = new Mutex();
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId));
    return stub.getAccessToken(opts);
  });
  // Comment writes keep the comment engine's own records. Their journal takes its IDs from the
  // edit store's counter, which holds the next unused ID and starts at 1 as a journal's does, so an
  // approval ID names one action of this binding, edit or comment: applyAction() and rejectAction()
  // tell the two apart by whether this journal holds it. A namespace would start a second counter.
  #commentJournal = new ActionJournal<DriveCommentAction>(this.ctx.storage.kv, {
    legacyKeys: { nextIdKey: PENDING_NEXT_ACTION_ID_KEY, recordPrefix: "docComments:action:" },
  });
  #commentAttempts = writeAttempts(this.ctx.storage.kv);
  #comments = DOC_COMMENT_ACTIONS.bind(this.#commentJournal, {
    // Read at apply: a Doc not created yet takes no comment writes, so none applies before it is.
    threads: docsThreads(() => this.#bound.documentId,
      new GoogleDocsApi(opts => this.#getAccessToken(opts)),
      new DriveApi(opts => this.#getAccessToken(opts))),
    docs: new GoogleDocsApi(opts => this.#getAccessToken(opts)),
    // Not gated on Drive's read and write choice, as the Doc's edits are not.
    writeRefusal: async () => undefined,
    attempts: this.#commentAttempts,
  });
  #reads = new ReadGate();

  constructor(ctx: DurableObjectState<GoogleDocGatekeeperImplProps>, env: Env) {
    super(ctx, env);
    // The real class's first start after applyCreation(): take over what the blank document left.
    let tabId = ctx.storage.kv.get<string>(CREATED_DOC_TAB_KEY);
    if (tabId !== undefined && !isSimulated(ctx.props)) {
      ctx.storage.transactionSync(() => adoptBlankDocument(ctx.storage.kv, tabId));
    }
  }

  /** The account and document this binding reaches, which a document not yet created has not. */
  get #bound(): { userObjectId: string; documentId: string } {
    return boundProps(this.ctx.props, "doc");
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  #readDocWriteReceipt(): GoogleDocWriteReceipt | undefined {
    return parseGoogleDocWriteReceipt(this.ctx.storage.kv.get<unknown>(DOC_WRITE_RECEIPT_KEY));
  }

  #clearDocWriteReceipt(markerId: string): void {
    if (this.#readDocWriteReceipt()?.markerId === markerId) {
      this.ctx.storage.kv.delete(DOC_WRITE_RECEIPT_KEY);
    }
  }


  /**
   * Hands one proven write from its pending action to a cleanup receipt, atomically.
   *
   * The cached snapshot goes with it. That snapshot predates this write, and once the action stops
   * being pending nothing overlays it, so a read interleaving with the cleanup below would report
   * content older than what is already committed. A read already awaiting Google sees the write
   * counted and fetches again rather than cache what it got.
   *
   * A write that added a tab hands that tab to the ID Google gave it in the same step, so no read
   * finds the add gone while the edits queued for its tab still name the provisional ID.
   */
  #handoffDocWriteReceipt(
    actionId: number,
    markerId: string,
    pendingActions: PendingActionStore<GoogleDocAction>,
    addedTab?: { provisionalTabId: string; tabId: string },
  ): void {
    this.ctx.storage.transactionSync(() => {
      let existing = this.#readDocWriteReceipt();
      if (existing && existing.markerId !== markerId) {
        throw new Error("A different Google Doc write receipt is already pending cleanup");
      }
      if (addedTab) adoptGoogleDocTab(this.ctx.storage.kv, addedTab.provisionalTabId, addedTab.tabId);
      this.ctx.storage.kv.put(DOC_WRITE_RECEIPT_KEY, { actionId, markerId });
      this.ctx.storage.kv.delete(DOC_SNAPSHOT_KEY);
      pendingActions.remove(actionId);
      this.#simulationCache.writes++;
    });
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("doc"),
        title,
        snippet: `Google Doc: ${title} (not created yet)`,
        suggestedBindingName: "GOOGLE_DOC",
        tsType: "GoogleDocSession",
      };
    }
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocumentMetadata(props.documentId);
    // Docs reads an Office file as though it were native but refuses every edit to it, so only
    // Drive can say. When Drive cannot answer, the document is described as it reads.
    let mimeType = await new DriveApi(opts => this.#getAccessToken(opts))
      .getFile(props.documentId).then(file => file.mimeType, () => undefined);
    if (officeLabel("doc", mimeType) !== undefined) throw officeFileError("doc");
    return {
      url: nativeFileUrl("doc", props.documentId),
      title: doc.title,
      snippet: `Google Doc: ${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDocTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [EDIT_DOCUMENT_ACTION, ADD_DOCUMENT_TAB_ACTION, ...this.#comments.autoApprovableKinds()];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let props = this.ctx.props;
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    // Only an undecided or claimed comment write can be applied again, so no other marker is read.
    this.#commentAttempts.sweep(new Set(this.#commentJournal.listPending().map(({ id }) => id)));
    let comments: DocCommentQueue = {
      submit: (queue, kind, payload) => this.#comments.submit(queue, kind, payload),
      undecided: read => this.#reads.read(() => read(this.#commentJournal.listUndecided())),
    };
    // A blank document always has a revision, so the session never reaches Drive for one.
    return new GoogleDocSessionImpl(
        isSimulated(props)
          ? new BlankGoogleDoc(props.creation.title)
          : new GoogleDocsApi(opts => this.#getAccessToken(opts)),
        new DriveApi(opts => this.#getAccessToken(opts)),
        isSimulated(props) ? UNCREATED_FILE_ID : props.documentId,
        approvalQueue.dup(),
        pendingActions,
        this.ctx.storage,
        this.#simulationCache,
        comments);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#actions.run(() => this.#isComment(actionId)
      ? this.#applyComment(actionId) : this.#applyAction(actionId));
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    return this.#actions.run(() => this.#isComment(actionId)
      ? this.#rejectComment(actionId) : this.#rejectAction(actionId));
  }

  /** Whether `actionId` names a comment write, pending or already applied, rather than an edit. */
  #isComment(actionId: number): boolean {
    return this.#commentJournal.get(actionId) !== undefined ||
      this.#commentJournal.wasApplied(actionId);
  }

  /**
   * Applies a comment write, and then drops its attempt marker, as a Drive binding does. A claim an
   * earlier apply left is handed back as undecided first: the marker decides whether its send is
   * looked for before anything is sent again. Comments depend on no edit, so they are applied in
   * any order.
   */
  #applyComment(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      if (this.#commentJournal.get(actionId)?.state === "claimed") {
        this.#commentJournal.restorePending(actionId);
      }
      await this.#comments.apply(actionId);
      this.#commentAttempts.delete(actionId);
    });
  }

  /** Withdraws a comment write. No edit waits on it, so nothing restarts. */
  #rejectComment(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      await this.#comments.reject(actionId);
      this.#commentAttempts.delete(actionId);
    });
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#actions.run(() => this.#applyCreation(creator, configuration));
  }

  async #applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    let { userObjectId, fileId, resourceUrl, getAccessToken: tokens } = await createFileOnce(
        this.ctx, creator, "doc", configuration,
        (title, getToken) => new GoogleDocsApi(getToken).createDocument(title));
    // Edits queued against the blank document name its tab, which the created one may not share.
    let [tab] = (await new GoogleDocsApi(tokens).getDocument(fileId)).tabs;
    this.ctx.storage.kv.put(CREATED_DOC_TAB_KEY, tab.tabId);
    return {
      class: this.ctx.exports.GoogleDocGatekeeperImpl({props: {userObjectId, documentId: fileId}}),
      resourceUrl,
    };
  }

  async #applyAction(actionId: number): Promise<void> {
    let { documentId } = this.#bound;
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let action = pending[pendingIndex].action;
    // Left pending, not removed: the overseer keeps its own record when this throws, so removing
    // ours would answer the next retry with "unknown action" instead of the reason. Rejecting
    // clears both.
    if (action.invalidatedReason) {
      throw new Error(action.invalidatedReason);
    }

    let firstPending = pending.find(record => !record.action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google Doc edits must be approved in order. Approve earlier edit ` +
        `${firstPending?.id} before edit ${actionId}.`);
    }

    if (!action.writeId) {
      action.writeId = crypto.randomUUID();
      pendingActions.put(actionId, action);
    }
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let landed: { writeMarker?: GoogleDocWriteMarker; snapshot: GoogleDocSnapshot } | undefined;
    await docDefinition(action).apply(action, {
      api,
      documentId,
      mimeType: async () =>
        (await new DriveApi(opts => this.#getAccessToken(opts)).getFile(documentId)).mimeType,
      receipt: () => this.#readDocWriteReceipt(),
      clearReceipt: markerId => this.#clearDocWriteReceipt(markerId),
      saved: (id, saved) => pendingActions.put(id, saved),
      landed: (id, writeMarker, snapshot, addedTab) => {
        landed = { writeMarker, snapshot };
        if (writeMarker) this.#handoffDocWriteReceipt(id, writeMarker.id, pendingActions, addedTab);
        else pendingActions.remove(id);
      },
      unapplyable: async (id, unapplied, reason, snapshot) => {
        invalidateGoogleDocAction(pendingActions, { id, action: unapplied }, reason);
        this.#simulationCache.current = undefined;
        await this.ctx.storage.put(DOC_SNAPSHOT_KEY, snapshot);
      },
    }, { id: actionId });
    let { writeMarker, snapshot } = landed!;
    if (writeMarker) {
      try {
        await api.deleteNamedRange(documentId, writeMarker.id, writeMarker.tabId);
        this.#clearDocWriteReceipt(writeMarker.id);
      } catch (error) {
        logger.warn("failed to clean up Google Doc write marker", {
          event: "google.doc.write-marker.cleanup.failed", actionId, error,
        });
      }
    }
    this.#simulationCache.current = undefined;

    // The handoff dropped the snapshot this edit made stale. Only edits queued behind it need the
    // new revision now, to be replayed over it; otherwise the next read fetches it, and an approval
    // that nobody reads after costs no full document read. They are listed again, since the
    // handoff of an added tab pointed those queued for it at Google's ID.
    let later = pendingActions.list()
      .filter(record => record.id > actionId && !record.action.invalidatedReason);
    if (writeMarker && later.length === 0) return;
    try {
      let refreshedSnapshot = snapshot;
      if (writeMarker) {
        refreshedSnapshot = googleDocSnapshot(await api.getDocument(documentId));
      }
      await this.ctx.storage.put(DOC_SNAPSHOT_KEY, refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          pendingActions,
          refreshedSnapshot,
          later,
          `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`);
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
      await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);
    }
  }

  async #rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);

    if (wasActive && index < pending.length - 1) {
      return {restart: true};
    }
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). The binding is one document, so we just
   * confirm the observer can open it with their own token (hasDocAccess, via the Drive/Docs ACL).
   * The document is the atomic unit (everything read through this binding is that one doc), so no
   * observers are tracked and removeObserver is a no-op. The overseer re-runs addObserver on every
   * open, catching loss of access promptly.
   *
   * Reads now also report the document as a `docs/document/<documentId>` subresource, which
   * verifyObserverAccess checks; this check stays for the reads made before they did.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasDocAccess(this.#bound.documentId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Doc, so they cannot be allowed " +
        "to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  /**
   * Checks the document subresource every read reports, failing the whole call for any other ID.
   * Each observer's UserAccount answers whether the Docs API opens the document for their own
   * account, reusing recent answers (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    requireFileSubresources(subresources, ["document"]);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

@validateRpc()
class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocReader;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: PendingActionStore<GoogleDocAction>;
  #storage: DurableObjectStorage;
  #simulationCache: GoogleDocSimulationCacheHolder;
  /** What every read reports: the document, or nothing for one not created yet. */
  #subresources: string[];
  #comments: DocCommentSession;

  constructor(
    docsApi: GoogleDocReader,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: PendingActionStore<GoogleDocAction>,
    storage: DurableObjectStorage,
    simulationCache: GoogleDocSimulationCacheHolder,
    comments: DocCommentQueue,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#storage = storage;
    this.#simulationCache = simulationCache;
    this.#subresources = documentId === UNCREATED_FILE_ID
      ? []
      : [fileSubresourceId({kind: "document", fileId: documentId})];
    this.#comments = new DocCommentSession({
      documentId, docs: docsApi, drive: driveApi, comments, approvalQueue,
      authorizeRead: description => this.#authorizeRead(description),
      onlyInPendingEdits: async (tabId, quote) => {
        if (this.#pendingActions.list().length === 0) return false;
        let { tab, markdown } = await this.#getSimulatedContent(tabId, "getContent");
        return !tab.markdown.includes(quote) && markdown.includes(quote);
      },
    });
  }

  listComments(): Promise<DriveComment[]> {
    return this.#comments.listComments();
  }

  comment(text: string, options: DocCommentOptions): Promise<DriveComment> {
    return this.#comments.comment(text, { ...options, tabId: this.#adoptedTabId(options.tabId) });
  }

  suggestEdit(
    oldText: string, newText: string, options?: DocSuggestEditOptions,
  ): Promise<DocSuggestion> {
    return this.#comments.suggestEdit(oldText, newText,
      options && { ...options, tabId: this.#adoptedTabId(options.tabId) });
  }

  /** `tabId`, or the ID Google gave the tab when it is the provisional ID of an applied add. */
  #adoptedTabId(tabId: string | undefined): string | undefined {
    return adoptedGoogleDocTabId(this.#storage.kv, tabId);
  }

  /**
   * The ID `tabId` names among `tabs`, a simulation's: `tabId` itself while the simulation lists
   * it, as it lists a provisional tab, edits replayed into it, until it sees the add's handoff
   * (even beside the tab Google made, which it lists once the add lands); otherwise Google's ID
   * for an applied add. Whatever is stored from it is read through `#adoptedTabId()` again.
   */
  #simulatedTabId(tabs: GoogleDocTabSnapshot[], tabId: string | undefined): string | undefined {
    return tabId === undefined || tabs.some(tab => tab.tabId === tabId)
      ? tabId : this.#adoptedTabId(tabId);
  }

  reply(commentId: string, text: string): Promise<DriveCommentReply> {
    return this.#comments.reply(commentId, text);
  }

  resolve(commentId: string, text?: string): Promise<DriveCommentReply> {
    return this.#comments.resolve(commentId, text);
  }

  // Every read authorizes through here, which reports the document it read as its subresource.
  #authorizeRead(description: Omit<ObservationDescription, "subresources">): Promise<void> {
    return this.#approvalQueue.authorizeObservation({
      ...description, subresources: this.#subresources,
    });
  }

  async #getSnapshot(): Promise<GoogleDocSnapshot> {
    for (;;) {
      let writes = this.#simulationCache.writes;
      // A snapshot written before tabs existed has no tab list and is simply replaced.
      let cached = await this.#storage.get<unknown>(DOC_SNAPSHOT_KEY);
      if (isGoogleDocSnapshot(cached) && Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) {
        return cached;
      }
      let snapshot = isGoogleDocSnapshot(cached) &&
          await googleDocRevisionUnchanged(this.#docsApi, this.#documentId, cached)
        ? { ...cached, fetchedAt: Date.now() }
        : googleDocSnapshot(await this.#docsApi.getDocument(this.#documentId));
      // What Google returned before a write landed is stale: the edit is no longer pending to be
      // replayed over it, so it would read as missing, and edits queued after it could not replay.
      if (writes !== this.#simulationCache.writes) continue;
      await this.#storage.put(DOC_SNAPSHOT_KEY, snapshot);
      return snapshot;
    }
  }

  /** The document with every pending action replayed over it. */
  async #simulate(): Promise<GoogleDocSimulation & { snapshot: GoogleDocSnapshot }> {
    // The snapshot and the queue replayed over it must come from one side of a write landing:
    // the handoff removes the write, and an added tab's handoff points the edits queued for it at
    // a tab an older snapshot lacks, which would invalidate them.
    let snapshot, writes;
    do {
      writes = this.#simulationCache.writes;
      snapshot = await this.#getSnapshot();
    } while (writes !== this.#simulationCache.writes);
    let pending = this.#pendingActions.list();
    let cached = this.#simulationCache.current;
    // An unknown revision cannot be shown to match, so the replay is recomputed.
    if (cached && cached.baseRevisionId !== undefined &&
        cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === googleDocPendingFingerprint(pending)) {
      return { snapshot, ...cached.simulation };
    }

    let simulation = invalidateUnreplayableGoogleDocActions(
        this.#pendingActions,
        snapshot,
        pending,
        "Pending Google Doc edit could not be replayed against the current document");
    this.#simulationCache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#pendingActions.list()),
      simulation,
    };
    return { snapshot, ...simulation };
  }

  /** The selected tab's content with every pending action replayed over it. */
  async #getSimulatedContent(
    tabId: string | undefined,
    operation: "getContent" | "replaceText" | "appendText",
  ): Promise<GoogleDocSimulatedContent & {
    snapshot: GoogleDocSnapshot,
    tab: GoogleDocTabSnapshot,
  }> {
    let simulation = await this.#simulate();
    let { snapshot, tabs } = simulation;
    let tab = resolveGoogleDocTab({ ...snapshot, tabs }, this.#simulatedTabId(tabs, tabId), operation);
    let content = simulation.contentByTabId.get(tab.tabId) ?? googleDocSimulatedContent(tab);
    return {snapshot, tab, ...content};
  }

  /**
   * Current title, and a modification time that only advances when something changed.
   *
   * Google Docs exposes no modification time, so the moment this binding first saw the current
   * revision stands in for it and is reused for as long as that revision holds — reading a
   * document must not make it look freshly edited. Without edit access there is no revision to
   * date, and Drive's own timestamp is used instead. Pending edits still move it forward, since
   * `getContent()` already shows them.
   */
  async getMetadata(): Promise<DocMetadata> {
    let metadata = await this.#docsApi.getDocumentMetadata(this.#documentId);
    let revisedAt = metadata.revisionId === undefined
        ? await this.#modifiedWithoutRevision()
        : this.#observeDocRevision(metadata.revisionId);
    let pendingActions = this.#pendingActions.list()
        .map(({action}) => action)
        .filter(action => !action.invalidatedReason);

    await this.#authorizeRead({
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    });

    let lastModified = pendingActions.reduce(
        (latest, action) => Math.max(latest, action.submittedAt), revisedAt);
    return {
      // UNCREATED_FILE_ID, empty, until the document is created.
      id: this.#documentId,
      title: metadata.title,
      lastModified: new Date(lastModified),
    };
  }

  /**
   * The modification time of a document Google reports no revision for.
   *
   * Without edit access there is no revision to date, so Drive is asked instead. An account
   * connected before per-resource grants may not hold the picker's metadata scope, leaving no
   * signal at all; the first observation then stands rather than every read looking like an edit.
   */
  async #modifiedWithoutRevision(): Promise<number> {
    try {
      return driveModifiedTime(await this.#driveApi.getFile(this.#documentId)).valueOf();
    } catch (error) {
      // Only a refused grant means no signal will ever arrive. A quota 403 (also 403), an outage
      // or a malformed body are transient or fixable, and dating the document from one would
      // report a changed document as unchanged for as long as Drive stays unhealthy.
      let refusedGrant = error instanceof DriveApiRequestError && error.status === 403 &&
          !error.isAccountWide;
      if (!refusedGrant) throw error;
      logger.warn("no Drive grant to date a Google Doc that has no revision", {
        event: "google.doc.metadata.drive.ungranted", error,
      });
      return this.#observeDocRevision(undefined);
    }
  }

  /**
   * When this binding first saw `revisionId`, recording it if the revision is new.
   *
   * An unreadable record is re-observed rather than rejected: it only dates a revision, so the
   * worst a lost record costs is one timestamp that moves when the document did not. Two absent
   * revisions count as the same: a document that offers no change token must not look edited by
   * every read, which is the opposite of what a cache needs from the same comparison.
   */
  #observeDocRevision(revisionId?: string): number {
    let stored = this.#storage.kv.get<unknown>(DOC_METADATA_REVISION_KEY);
    if (stored && typeof stored === "object") {
      let { revisionId: seen, observedAt } = stored as Partial<GoogleDocMetadataRevision>;
      if (seen === revisionId &&
          typeof observedAt === "number" && Number.isFinite(observedAt)) {
        return observedAt;
      }
    }
    let observedAt = Date.now();
    this.#storage.kv.put<GoogleDocMetadataRevision>(
      DOC_METADATA_REVISION_KEY, { revisionId, observedAt });
    return observedAt;
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    let { tabs } = await this.#simulate();

    await this.#authorizeRead({
      title: "List Google Doc tabs",
      description: "Read the document's tab names and hierarchy.",
    });

    return tabs.map(googleDocTabMetadata);
  }

  async addTab(title: string, options: { parentTabId?: string; index?: number } = {})
      : Promise<string> {
    checkDocTabTitle(title);
    let { index } = options;
    let provisionalTabId = `${PROVISIONAL_TAB_PREFIX}${crypto.randomUUID()}`;
    let simulation, action: GoogleDocAddTabAction, tabs, simulatedParent;
    try {
      simulation = await this.#simulate();
      simulatedParent = this.#simulatedTabId(simulation.tabs, options.parentTabId);
      tabs = insertDocTab(simulation.tabs, newGoogleDocTab({ provisionalTabId, title }),
        { parentTabId: simulatedParent, index });
      let parentTabId = this.#adoptedTabId(simulatedParent);
      action = {
        type: "addTab",
        provisionalTabId,
        title,
        ...parentTabId === undefined ? {} : { parentTabId },
        ...index === undefined ? {} : { index },
        submittedAt: Date.now(),
        baseRevisionId: simulation.snapshot.revisionId,
        writeId: crypto.randomUUID(),
      };
    } catch (error) {
      // The error says whether that parent exists, and how many tabs it holds.
      await this.#authorizeRead({
        title: "List Google Doc tabs",
        description: "Read the document's tab names and hierarchy.",
      });
      throw error;
    }

    let parent = simulation.tabs.find(tab => tab.tabId === simulatedParent);
    let siblings = tabs.filter(tab => tab.parentTabId === simulatedParent).length;
    action.display = {
      placement:
        `Add a new, empty tab ${parent ? `under tab ${googleDocTabLabel(parent)}` : "at the top level"}` +
        (index === undefined ? ", after the tabs already there." :
          `, at position ${index + 1} of ${siblings}.`),
    };
    await this.#submit(action);
    return provisionalTabId;
  }

  /**
   * Stores `action` and submits it for approval with the card its definition builds, removing it
   * again if the submission fails. Nothing is awaited between the store and the submission.
   */
  async #submit(action: GoogleDocAction): Promise<void> {
    let definition = docDefinition(action);
    let presentation = describeDocEdit(action);
    let actionId = this.#pendingActions.submit(action);
    this.#simulationCache.current = undefined;

    try {
      await this.#approvalQueue.submitAction(actionId, {
        ...presentation,
        actionKind: definition.kind,
        autoApprovable: definition.autoApprovable,
      });
    } catch (error) {
      this.#pendingActions.remove(actionId);
      this.#simulationCache.current = undefined;
      throw error;
    }
  }

  async getContent(tabId?: string): Promise<string> {
    let selected;
    try {
      selected = await this.#getSimulatedContent(tabId, "getContent");
    } catch (error) {
      // The error says whether that tab exists, so the attempt discloses something too.
      await this.#authorizeRead({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }

    await this.#authorizeRead({
      title: "Read Google Doc content",
      description:
        `Read the full simulated content of tab ${googleDocTabLabel(selected.tab)} as Markdown.`,
    });
    return selected.markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }
    assertGoogleDocActionMarkdownSize(oldMarkdown, newMarkdown);

    let selected;
    let renderedNewMarkdown: string;
    try {
      selected = await this.#getSimulatedContent(tabId, "replaceText");
      let start = findUniqueMarkdown(
        selected.markdown, oldMarkdown, "replaceText", selected.tab.tabId,
      );
      renderedNewMarkdown = canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown);
      applyMarkdownEdit(selected, start, start + oldMarkdown.length, renderedNewMarkdown);
      // With no earlier edit to this tab, approval will build exactly these requests.
      if (selected.markdown === selected.tab.markdown) {
        computeReplaceOperations(selected.tab.sourceMap, selected.markdown, start,
          start + oldMarkdown.length, renderedNewMarkdown, selected.tab.tabId);
      }
    } catch (error) {
      // The error says whether that tab, or that text, exists.
      await this.#authorizeRead({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }
    let {snapshot, tab} = selected;

    let action: GoogleDocAction = {
      type: "replaceText",
      // Read again: the add of a tab selected before the await above may have applied since.
      tabId: this.#adoptedTabId(tab.tabId),
      submittedAt: Date.now(),
      markdownVersion: MARKDOWN_RENDERING_VERSION,
      baseRevisionId: snapshot.revisionId,
      writeId: crypto.randomUUID(),
      oldMarkdown,
      newMarkdown,
      display: {
        tab: googleDocTabLabel(tab),
        ...(renderedNewMarkdown === newMarkdown ? {} : { rendered: renderedNewMarkdown }),
      },
    };
    await this.#submit(action);
  }

  async appendText(markdown: string, tabId?: string): Promise<void> {
    assertGoogleDocActionMarkdownSize(markdown);
    let selected;
    try {
      selected = await this.#getSimulatedContent(tabId, "appendText");
      requireGoogleDocAppendIndex(selected.appendIndex);
    } catch (error) {
      // The error says whether that tab exists, so the attempt discloses something too.
      await this.#authorizeRead({
        title: "Read Google Doc content",
        description: "Read the content of one tab of the document.",
      });
      throw error;
    }
    let {snapshot, tab} = selected;

    let action: GoogleDocAction = {
      type: "appendText",
      // Read again: the add of a tab selected before the await above may have applied since.
      tabId: this.#adoptedTabId(tab.tabId),
      submittedAt: Date.now(),
      markdownVersion: MARKDOWN_RENDERING_VERSION,
      baseRevisionId: snapshot.revisionId,
      writeId: crypto.randomUUID(),
      markdown,
      display: { tab: googleDocTabLabel(tab) },
    };
    await this.#submit(action);
  }
}


@validateRpc()
export class GoogleDocReadSessionImpl extends RpcTarget implements GoogleDocReadSession {
  #docsApi: GoogleDocsApi;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  /** A fetch still in flight, so reads issued together observe one revision. */
  #inFlight?: Promise<GoogleDocSnapshot>;
  /** The last revision a completed scope check approved, the only one a later read may reuse. */
  #approved?: GoogleDocSnapshot;
  #read: NativeRead;

  constructor(
    docsApi: GoogleDocsApi,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#docsApi = docsApi;
    this.#driveApi = driveApi;
    this.#documentId = documentId;
    this.#approvalQueue = approvalQueue;
    this.#read = read;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getMetadata(): Promise<DocMetadata> {
    return this.#read(async () => {
      let file = await this.#driveApi.getFile(this.#documentId);
      return { id: this.#documentId, title: file.name, lastModified: driveModifiedTime(file) };
    }, () => ({
      title: "Read Google Doc metadata",
      description: "Read the current title and modification time of the Drive document.",
    }));
  }

  /**
   * Reads one snapshot under the binding's scope guard.
   *
   * Only a revision a whole guard cycle approved becomes reusable. The scope check straddles the
   * fetch, so a revision fetched while the document was outside must never reach a later read --
   * and rolling it back after the refusal is too late, since a read that chained onto it meanwhile
   * already holds it. Reads issued together still share one fetch: each brackets that fetch with
   * its own checks, exactly as a lone read does.
   */
  async #readSnapshot<T>(
    use: (snapshot: GoogleDocSnapshot) => T,
    observe: (value: T) => NativeObservation,
  ): Promise<T> {
    let snapshot: GoogleDocSnapshot | undefined;
    let value = await this.#read(async () => {
      snapshot = await (this.#inFlight ??= this.#nextSnapshot()
        .finally(() => { this.#inFlight = undefined; }));
      return use(snapshot);
    }, observe);
    // A slow guard must not republish its older revision over a newer one already approved.
    if (snapshot && snapshot.fetchedAt >= (this.#approved?.fetchedAt ?? 0)) {
      this.#approved = snapshot;
    }
    return value;
  }

  /** Reuse one revision for the TTL, then confirm it is still current before reusing it again. */
  async #nextSnapshot(): Promise<GoogleDocSnapshot> {
    let cached = this.#approved;
    if (cached) {
      if (Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) return cached;
      if (await googleDocRevisionUnchanged(this.#docsApi, this.#documentId, cached)) {
        cached.fetchedAt = Date.now();
        return cached;
      }
    }
    return googleDocSnapshot(await this.#docsApi.getDocument(this.#documentId));
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    return this.#readSnapshot(
      snapshot => snapshot.tabs.map(googleDocTabMetadata),
      () => ({
        title: "List Google Doc tabs",
        description: "Read the document's tab names and hierarchy.",
      }));
  }

  async getContent(tabId?: string): Promise<string> {
    // The selector error says whether a tab exists, so a failed attempt discloses something too
    // and has to be authorized. It rides back as a value so one guarded read covers both outcomes.
    let selection = await this.#readSnapshot(
      (snapshot): { tab: GoogleDocTabSnapshot } | { error: unknown } => {
        try {
          return { tab: resolveGoogleDocTab(snapshot, tabId, "getContent") };
        } catch (error) {
          return { error };
        }
      },
      result => ({
        title: "Read Google Doc content",
        description: "tab" in result
          ? `Read the current content of tab ${googleDocTabLabel(result.tab)} as Markdown.`
          : "Read the content of one tab of the document.",
      }));
    if (!("tab" in selection)) throw selection.error;
    return selection.tab.markdown;
  }
}
