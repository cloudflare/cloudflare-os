/**
 * The Google Doc edits: how each is stored, replayed over a document, described to the approver
 * and written once approved, over the host of whichever connection queued it.
 */
import { ActionKind } from '@gadgets/workshop-shared/gatekeeper';
import {
  ActionApplyError, type ActionDefinition, type ActionPresentation,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline } from "@gadgets/gatekeeper-kit/action-description";
import { type GoogleDocTab } from "./docs-types";
import {
  blankDocsTab, docsWriteFailure, GoogleDocsApi, type DocsBatchReply, type GoogleDocReader,
  type GoogleDocsDocument, type GoogleDocsTab,
} from "./docs-api";
import { insertDocTab, type DocTabPlacement } from "./docs-tabs";
import {
  applyMarkdownEdit, assertMarkdownWriteComplexity, canonicalizeMarkdownForWrite,
  canonicalizeMarkdownReplacement,
  computeReplaceOperations, docTabToMarkdown, markdownToDocRequests, MARKDOWN_RENDERING_VERSION,
  type DocTabSnapshot, type EditableMarkdown,
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
 * What an edit's card shows beyond the edit itself, recorded with it, since a card is built once,
 * from the stored edit. Display only: nothing replays or applies it.
 */
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

type GoogleDocEditAction = GoogleDocReplaceAction | GoogleDocAppendAction;
export type GoogleDocAction = GoogleDocEditAction | GoogleDocAddTabAction;

export const DOC_WRITE_RECEIPT_KEY = "docWriteReceipt";
export const DOC_METADATA_REVISION_KEY = "docMetadataRevision";
/** The last document read, replayed for this long before its revision is rechecked. */
export const DOC_SNAPSHOT_TTL_MS = 10_000;
/** The last document read. Pending actions overlay it, so it outlives none. */
export const DOC_SNAPSHOT_KEY = "docSnapshot";
/** Name prefix of the named range that marks one Gadgets write. Permanent: retries match on it. */
const WRITE_MARKER_PREFIX = "gadgets-write-";
/** Prefix of the ID `addTab()` returns for a tab Google has not added yet. */
export const PROVISIONAL_TAB_PREFIX = "pending-tab-";
/** Each added tab's provisional ID to the ID Google gave it, oldest first. */
export const DOC_ADDED_TABS_KEY = "docAddedTabs";
/** How many added tabs' provisional IDs keep resolving after their adds apply. */
export const MAX_DOC_ADDED_TABS = 100;

export type GoogleDocWriteReceipt = { actionId: number; markerId: string };

/** The document revision this binding has already reported, and when it first saw it. */
export type GoogleDocMetadataRevision = { revisionId?: string; observedAt: number };
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
export type GoogleDocTabSnapshot = DocTabSnapshot & { committedWriteIds: string[] };

/** A whole document as this gatekeeper caches it: one independent rendering per tab. */
export type GoogleDocSnapshot = {
  /** Rendering schema of `tabs`; bumped by the converter that produced them. */
  formatVersion: typeof MARKDOWN_RENDERING_VERSION;
  title: string;
  /** Absent unless the caller can edit the document; see `GoogleDocsDocument.revisionId`. */
  revisionId?: string;
  tabs: GoogleDocTabSnapshot[];
  /** `Date.now()` at the time of fetch, used for TTL checks. */
  fetchedAt: number;
}

export function googleDocSnapshot(document: GoogleDocsDocument): GoogleDocSnapshot {
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
export function isGoogleDocSnapshot(value: unknown): value is GoogleDocSnapshot {
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
export async function googleDocRevisionUnchanged(
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
export function resolveGoogleDocTab(
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
export function googleDocTabMetadata(tab: DocTabSnapshot): GoogleDocTab {
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
export function googleDocTabLabel(tab: DocTabSnapshot): string {
  let id = tab.tabId.startsWith(PROVISIONAL_TAB_PREFIX) ? "new tab" : tab.tabId;
  return `"${plainInline(tab.title)}" (${id})`;
}

export function parseGoogleDocWriteReceipt(value: unknown): GoogleDocWriteReceipt | undefined {
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

export type GoogleDocPendingAction = { id: number; action: GoogleDocAction };

export type GoogleDocSimulatedContent = EditableMarkdown & {
  /** The valid document insertion point for an append, absent after trailing structure. */
  appendIndex: number | undefined;
};

function googleDocAppendIndex(tab: GoogleDocTabSnapshot): number | undefined {
  return tab.sourceMap.blocks.at(-1)?.docEnd === tab.bodyEndIndex
    ? tab.bodyEndIndex - 1
    : undefined;
}

export function requireGoogleDocAppendIndex(appendIndex: number | undefined): number {
  if (appendIndex === undefined) {
    throw new Error(
      "appendText: the selected tab does not end in a paragraph. " +
      "Add a paragraph after its final table or structural element and retry.",
    );
  }
  return appendIndex;
}

export function googleDocSimulatedContent(tab: GoogleDocTabSnapshot): GoogleDocSimulatedContent {
  return {
    markdown: tab.markdown,
    protectedRanges: tab.sourceMap.protectedRanges,
    appendIndex: googleDocAppendIndex(tab),
  };
}

/** A tab `addTab()` queued, rendered as Google adds it: empty. */
export function newGoogleDocTab(
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
export function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string): string;
export function adoptedGoogleDocTabId(
  kv: DurableObjectStorage["kv"], tabId: string | undefined,
): string | undefined;
export function adoptedGoogleDocTabId(kv: DurableObjectStorage["kv"], tabId: string | undefined) {
  if (!tabId?.startsWith(PROVISIONAL_TAB_PREFIX)) return tabId;
  return kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY)?.[tabId] ?? tabId;
}

/** The document as the pending queue leaves it. */
export type GoogleDocSimulation = {
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

export type GoogleDocSimulationCacheHolder = {
  current?: GoogleDocSimulatedContentCache;
  /** Writes landed in the document, counted so a read awaiting Google across one can tell. */
  writes: number;
}

export function googleDocPendingFingerprint(pending: GoogleDocPendingAction[]): string {
  return JSON.stringify(pending);
}

const MAX_GOOGLE_DOC_ACTION_MARKDOWN_BYTES = 1024 * 1024;
const googleDocActionEncoder = new TextEncoder();

export function assertGoogleDocActionMarkdownSize(...values: string[]): void {
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
export function findUniqueMarkdown(
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

/** Records that edit `record` can no longer be replayed, for `reason`. */
type GoogleDocInvalidator = (record: GoogleDocPendingAction, reason: string) => void;

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
export function invalidateUnreplayableGoogleDocActions(
  invalidate: GoogleDocInvalidator,
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
      invalidate(
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

/** The kind of the text edits, replaceText and appendText. A new tab has a kind of its own. */
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
export function describeDocEdit(action: GoogleDocAction): ActionPresentation {
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
export function docDefinition(action: GoogleDocAction): ActionDefinition<GoogleDocAction, DocHost> {
  return DOC_DEFINITIONS[action.type] as ActionDefinition<GoogleDocAction, DocHost>;
}
