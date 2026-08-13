// Phase 2 machinery for the Confluence gatekeeper: pending-action storage, provisional IDs for
// not-yet-created content, response caching, action simulation (so reads reflect pending writes),
// and the apply/reject/revert logic invoked by the gatekeeper DO.
//
// Design (mirrors the Notion gatekeeper): we cache the *base* truth fetched from Confluence (short
// TTL) and overlay pending (submitted-but-unapplied) actions at read time. submitAction() records
// an action and leaves the cache untouched; applyAction() performs the real API call and
// invalidates affected cache entries; rejectAction() drops the record so the overlay recomputes
// without it.

import type { RpcStub } from "cloudflare:workers";
import type { ActionDescription, ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  ConfluenceApi,
  contentBodyMarkdown,
  contentToSummary,
  type ContentResponse,
} from "./confluence-api";
import { markdownToStorage, storageToMarkdown } from "./confluence-markdown";
import type { Comment, ContentSummary, ContentType } from "./types";

// ---------------------------------------------------------------------------------------------
// Action model

export type ContentParent =
  | { type: "space"; spaceKey: string }
  | { type: "page"; parentId: string; spaceKey?: string };

export type ConfluenceAction =
  | {
      type: "createContent";
      provisionalId: string;
      kind: ContentType;
      parent: ContentParent;
      title: string;
      content?: string;
      status: "current" | "draft";
    }
  | { type: "setContent"; contentId: string; markdown: string; previousMarkdown: string }
  | { type: "appendContent"; contentId: string; markdown: string; previousMarkdown?: string }
  | { type: "setTitle"; contentId: string; title: string; previousTitle: string }
  | { type: "addComment"; contentId: string; text: string }
  | { type: "addLabel"; contentId: string; name: string }
  | { type: "removeLabel"; contentId: string; name: string }
  | {
      type: "uploadAttachment";
      contentId: string;
      filename: string;
      mediaType: string;
      data: Uint8Array;
      comment?: string;
    }
  | { type: "trash"; contentId: string }
  | { type: "restore"; contentId: string };

export type StoredActionRecord = {
  id: number;
  action: ConfluenceAction;
  state: "pending" | "applied" | "reverted";
  submittedAt: number;
  /** For createContent / addComment: the real content ID assigned on apply. */
  createdContentId?: string;
  /** For uploadAttachment: the attachment ID assigned on apply. */
  createdAttachmentId?: string;
};

/** The content (provisional or real) an action targets, or null if it targets none. */
function actionContentId(action: ConfluenceAction): string | null {
  return action.type === "createContent" ? action.provisionalId : action.contentId;
}

// ---------------------------------------------------------------------------------------------
// Store: caching + pending-action storage (backed by the gatekeeper DO's KV storage)

type Kv = DurableObjectStorage["kv"];
const CONTENT_TTL_MS = 30_000;

type ContentCache = { fetchedAt: number; content: ContentResponse };

export class ConfluenceStore {
  #kv: Kv;
  #api: ConfluenceApi;

  constructor(kv: Kv, api: ConfluenceApi) {
    this.#kv = kv;
    this.#api = api;
  }

  get api(): ConfluenceApi {
    return this.#api;
  }

  // --- sequential IDs ---

  nextActionId(): number {
    const id = this.#kv.get<number>("seq:action") ?? 1;
    this.#kv.put("seq:action", id + 1);
    return id;
  }

  nextProvisionalId(): string {
    const n = this.#kv.get<number>("seq:provisional") ?? 1;
    this.#kv.put("seq:provisional", n + 1);
    return `~${n}`;
  }

  // --- pending actions ---

  putAction(record: StoredActionRecord): void {
    this.#kv.put(`action:${record.id}`, record);
  }

  getAction(id: number): StoredActionRecord | undefined {
    return this.#kv.get<StoredActionRecord>(`action:${id}`);
  }

  deleteAction(id: number): void {
    this.#kv.delete(`action:${id}`);
  }

  allActions(): StoredActionRecord[] {
    return [...this.#kv.list<StoredActionRecord>({ prefix: "action:" })]
      .map(([, record]) => record)
      .toSorted((a, b) => a.id - b.id);
  }

  pendingActions(): StoredActionRecord[] {
    return this.allActions().filter(r => r.state === "pending");
  }

  /** Pending actions targeting a piece of content (addressed by either provisional or real ID). */
  pendingForContent(contentId: string): StoredActionRecord[] {
    const target = this.resolveId(contentId);
    return this.pendingActions().filter(r => {
      const t = actionContentId(r.action);
      return t !== null && this.resolveId(t) === target;
    });
  }

  // --- provisional ID resolution ---

  static isProvisional(id: string): boolean {
    return id.startsWith("~");
  }

  setProvisional(provisionalId: string, realId: string): void {
    this.#kv.put(`prov:${provisionalId}`, realId);
  }

  resolveId(id: string): string {
    if (!ConfluenceStore.isProvisional(id)) return id;
    return this.#kv.get<string>(`prov:${id}`) ?? id;
  }

  knowsProvisional(id: string): boolean {
    if (this.resolveId(id) !== id) return true;
    return this.allActions().some(r => r.action.type === "createContent" && r.action.provisionalId === id);
  }

  createActionFor(provisionalId: string): StoredActionRecord | undefined {
    return this.allActions().find(
      r => r.action.type === "createContent" && r.action.provisionalId === provisionalId);
  }

  // --- cached base reads ---

  async getContentResponse(id: string, bypassCache = false): Promise<ContentResponse> {
    const realId = this.resolveId(id);
    if (!bypassCache) {
      const cached = this.#kv.get<ContentCache>(`cache:content:${realId}`);
      if (cached && Date.now() - cached.fetchedAt < CONTENT_TTL_MS) return cached.content;
    }
    const content = await this.#api.getContentById(realId);
    this.#kv.put<ContentCache>(`cache:content:${realId}`, { fetchedAt: Date.now(), content });
    return content;
  }

  /** The kind (page vs blog post) of a piece of content, resolved (and cached) via its response. */
  async getContentKind(id: string): Promise<ContentType> {
    return contentKindOf(await this.getContentResponse(id));
  }

  /** Resolve a space key to its numeric v2 space ID (cached). */
  async getSpaceId(key: string): Promise<string> {
    const cached = this.#kv.get<string>(`space:${key}`);
    if (cached) return cached;
    const space = await this.#api.getSpaceByKey(key);
    this.#kv.put(`space:${key}`, space.id);
    return space.id;
  }

  invalidateContent(id: string): void {
    this.#kv.delete(`cache:content:${this.resolveId(id)}`);
  }
}

const contentKindOf = (c: ContentResponse): ContentType => (c.type === "blogpost" ? "blogpost" : "page");

// ---------------------------------------------------------------------------------------------
// Simulation: overlay pending actions onto base reads.

/** The effective title after applying pending records (setTitle / createContent). */
export function simulateTitle(records: StoredActionRecord[], baseTitle: string): string {
  let title = baseTitle;
  for (const r of records) {
    if (r.action.type === "setTitle") title = r.action.title;
    else if (r.action.type === "createContent") title = r.action.title;
  }
  return title;
}

/** The effective body Markdown after applying pending records. `base` is null for provisional content. */
export function simulateBody(base: string | null, records: StoredActionRecord[]): string {
  let body = base ?? "";
  for (const r of records) {
    const a = r.action;
    if (a.type === "setContent") body = a.markdown;
    else if (a.type === "appendContent") body = body ? `${body}\n\n${a.markdown}` : a.markdown;
    else if (a.type === "createContent" && base === null && a.content) body = a.content;
  }
  return body;
}

/** The effective label set after applying pending add/removeLabel records. */
export function simulateLabels(base: string[], records: StoredActionRecord[]): string[] {
  const labels = [...base];
  for (const r of records) {
    if (r.action.type === "addLabel") {
      if (!labels.includes(r.action.name)) labels.push(r.action.name);
    } else if (r.action.type === "removeLabel") {
      const i = labels.indexOf(r.action.name);
      if (i >= 0) labels.splice(i, 1);
    }
  }
  return labels;
}

/** Base comments plus pending ones (only appended on the first page to avoid duplication). */
export function simulateComments(base: Comment[], records: StoredActionRecord[]): Comment[] {
  const out = [...base];
  for (const r of records) {
    if (r.action.type === "addComment") {
      out.push({ id: `~comment-${r.id}`, text: r.action.text, author: null, createdAt: new Date(r.submittedAt) });
    }
  }
  return out;
}

/** The effective trashed state implied by pending trash/restore actions, or undefined if untouched. */
export function simulateTrashed(records: StoredActionRecord[]): boolean | undefined {
  let state: boolean | undefined;
  for (const r of records) {
    if (r.action.type === "trash") state = true;
    else if (r.action.type === "restore") state = false;
  }
  return state;
}

// A summary for a provisional (not-yet-created) piece of content.
function provisionalSummary(record: StoredActionRecord, store: ConfluenceStore): ContentSummary {
  const a = record.action;
  if (a.type !== "createContent") throw new Error("not a create action");
  const records = store.pendingForContent(a.provisionalId);
  return {
    id: a.provisionalId,
    type: a.kind,
    title: simulateTitle(records, a.title),
    spaceKey: a.parent.spaceKey,
    url: `${store.api.webBase}/pages/${a.provisionalId}`,
    status: a.status === "draft" ? "draft" : "current",
    createdAt: new Date(record.submittedAt),
    lastUpdatedAt: new Date(record.submittedAt),
  };
}

// Drop base items that are pending-trashed and append provisional creations matching `keep`.
function overlayList(
  base: ContentSummary[],
  store: ConfluenceStore,
  keep: (action: Extract<ConfluenceAction, { type: "createContent" }>) => boolean,
  includeProvisional: boolean,
): ContentSummary[] {
  const pending = store.pendingActions();
  const trashed = new Set(
    pending
      .filter(r => r.action.type === "trash")
      .map(r => store.resolveId(actionContentId(r.action)!)));
  const out = base.filter(item => !trashed.has(store.resolveId(item.id)));

  if (includeProvisional) {
    for (const r of pending) {
      // Include only creations that haven't been applied yet (still resolve to a provisional ID).
      if (r.action.type === "createContent" && keep(r.action) &&
          ConfluenceStore.isProvisional(store.resolveId(r.action.provisionalId))) {
        out.push(provisionalSummary(r, store));
      }
    }
  }
  return out;
}

/** Overlay for a space's content listing (pages or blog posts). */
export function overlaySpaceContent(
  base: ContentSummary[], store: ConfluenceStore, spaceKey: string, type: ContentType, firstPage: boolean,
): ContentSummary[] {
  return overlayList(base, store, a =>
    a.kind === type && a.parent.spaceKey === spaceKey && (type === "blogpost" || a.parent.type === "space"),
    firstPage);
}

/** Overlay for a page's child-page listing. */
export function overlayChildPages(
  base: ContentSummary[], store: ConfluenceStore, parentId: string, firstPage: boolean,
): ContentSummary[] {
  const resolvedParent = store.resolveId(parentId);
  return overlayList(base, store, a =>
    a.kind === "page" && a.parent.type === "page" && store.resolveId(a.parent.parentId) === resolvedParent,
    firstPage);
}

/** Overlay for search results. */
export function overlaySearch(
  base: ContentSummary[], store: ConfluenceStore, firstPage: boolean, typeFilter?: ContentType,
): ContentSummary[] {
  return overlayList(base, store, a => !typeFilter || a.kind === typeFilter, firstPage);
}

// ---------------------------------------------------------------------------------------------
// Observation / action descriptions

export function observation(title: string, description: string): ObservationDescription {
  return { title, description };
}

const kind = (tag: string, label: string): ActionDescription["actionKind"] => ({ tag: `confluence.${tag}`, label });

function describeAction(action: ConfluenceAction): ActionDescription {
  switch (action.type) {
    case "createContent":
      return {
        title: `Create Confluence ${action.kind === "blogpost" ? "blog post" : "page"}`,
        description: `Create a new ${action.kind === "blogpost" ? "blog post" : "page"} titled **${action.title}**` +
          (action.parent.type === "page" ? " as a child page." : ` in space ${action.parent.spaceKey}.`),
        implementsRevert: true,
        actionKind: kind("createContent", "Create page/blog post"),
      };
    case "setContent":
      return {
        title: "Replace Confluence page content",
        description: `Replace the body with:\n\n${truncate(action.markdown)}`,
        implementsRevert: true,
        actionKind: kind("editContent", "Edit page content"),
      };
    case "appendContent":
      return {
        title: "Append to Confluence page",
        description: `Append to the body:\n\n${truncate(action.markdown)}`,
        implementsRevert: true,
        actionKind: kind("editContent", "Edit page content"),
      };
    case "setTitle":
      return {
        title: "Rename Confluence content",
        description: `Change the title to **${action.title}** (was “${action.previousTitle}”).`,
        implementsRevert: true,
        actionKind: kind("setTitle", "Rename content"),
      };
    case "addComment":
      return {
        title: "Comment on Confluence content",
        description: `Post a comment:\n\n${truncate(action.text)}`,
        implementsRevert: true,
        actionKind: kind("addComment", "Add comment"),
      };
    case "addLabel":
      return {
        title: "Add label to Confluence content",
        description: `Add the label \`${action.name}\`.`,
        implementsRevert: true,
        actionKind: kind("label", "Add/remove label"),
      };
    case "removeLabel":
      return {
        title: "Remove label from Confluence content",
        description: `Remove the label \`${action.name}\`.`,
        implementsRevert: true,
        actionKind: kind("label", "Add/remove label"),
      };
    case "uploadAttachment":
      return {
        title: "Upload attachment to Confluence",
        description: `Upload **${action.filename}** (${action.mediaType}, ${action.data.byteLength} bytes).`,
        implementsRevert: true,
        actionKind: kind("uploadAttachment", "Upload attachment"),
      };
    case "trash":
      return {
        title: "Move Confluence content to trash",
        description: "Move this content to the trash (reversible).",
        implementsRevert: true,
        actionKind: kind("trash", "Trash content"),
      };
    case "restore":
      return {
        title: "Restore Confluence content from trash",
        description: "Restore this content from the trash.",
        implementsRevert: true,
        actionKind: kind("trash", "Trash content"),
      };
  }
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ---------------------------------------------------------------------------------------------
// Staging

/** Record a pending action and submit it for approval. Rolls back the record if submit fails. */
export async function stageAction(
  store: ConfluenceStore, approvalQueue: RpcStub<ApprovalQueue>, action: ConfluenceAction,
): Promise<number> {
  const id = store.nextActionId();
  store.putAction({ id, action, state: "pending", submittedAt: Date.now() });
  try {
    await approvalQueue.submitAction(id, describeAction(action));
  } catch (err) {
    store.deleteAction(id);
    throw err;
  }
  return id;
}

// ---------------------------------------------------------------------------------------------
// Apply / reject / revert

function requireResolved(store: ConfluenceStore, id: string): string {
  const resolved = store.resolveId(id);
  if (ConfluenceStore.isProvisional(resolved)) {
    throw new Error(`Cannot apply: content ${id} has not been created yet.`);
  }
  return resolved;
}

/**
 * The status to send when updating a page/blog post. Preserves an existing draft so that editing
 * a draft doesn't publish it: `updateContent` defaults status to "current", and passing "current"
 * for a draft transitions it to published.
 */
function preservedStatus(current: ContentResponse): "draft" | "current" {
  return current.status === "draft" ? "draft" : "current";
}

async function applyAction(store: ConfluenceStore, record: StoredActionRecord): Promise<void> {
  const api = store.api;
  const action = record.action;

  switch (action.type) {
    case "createContent": {
      const spaceKey = action.parent.spaceKey;
      if (!spaceKey) throw new Error("Cannot create content without a space.");
      const spaceId = await store.getSpaceId(spaceKey);
      const storageValue = markdownToStorage(action.content ?? "");
      const created = action.kind === "blogpost"
        ? await api.createBlogPost({ spaceId, title: action.title, status: action.status, storageValue })
        : await api.createPage({
            spaceId,
            title: action.title,
            status: action.status,
            storageValue,
            parentId: action.parent.type === "page" ? requireResolved(store, action.parent.parentId) : undefined,
          });
      record.createdContentId = created.id;
      store.setProvisional(action.provisionalId, created.id);
      store.putAction(record);
      break;
    }
    case "setContent": {
      const id = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id, true);
      await api.updateContent({
        id,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: current.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: markdownToStorage(action.markdown),
        status: preservedStatus(current),
      });
      store.invalidateContent(id);
      break;
    }
    case "appendContent": {
      const id = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id, true);
      const combined = (current.body?.storage?.value ?? "") + markdownToStorage(action.markdown);
      await api.updateContent({
        id,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: current.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: combined,
        status: preservedStatus(current),
      });
      store.invalidateContent(id);
      break;
    }
    case "setTitle": {
      const id = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id, true);
      await api.updateContent({
        id,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: action.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: current.body?.storage?.value ?? "",
        status: preservedStatus(current),
      });
      store.invalidateContent(id);
      break;
    }
    case "addComment": {
      const id = requireResolved(store, action.contentId);
      // The comment container type must match the target (blog posts reject a "page" container).
      const target = await store.getContentResponse(id, true);
      const created = await api.addComment(id, markdownToStorage(action.text),
        target.type === "blogpost" ? "blogpost" : "page");
      record.createdContentId = created.id;
      store.putAction(record);
      break;
    }
    case "addLabel":
      await api.addLabel(requireResolved(store, action.contentId), action.name);
      store.invalidateContent(action.contentId);
      break;
    case "removeLabel":
      await api.removeLabel(requireResolved(store, action.contentId), action.name);
      store.invalidateContent(action.contentId);
      break;
    case "uploadAttachment": {
      const id = requireResolved(store, action.contentId);
      const created = await api.uploadAttachment(id, action);
      record.createdAttachmentId = created.id;
      store.putAction(record);
      break;
    }
    case "trash": {
      const id = requireResolved(store, action.contentId);
      await api.trashContent(id, await store.getContentKind(id));
      store.invalidateContent(action.contentId);
      break;
    }
    case "restore":
      await api.restoreContent(requireResolved(store, action.contentId));
      store.invalidateContent(action.contentId);
      break;
  }

  // The action is now reflected on Confluence; drop it from the pending set so reads stop
  // overlaying it on top of the (refetched) real state.
  record.state = "applied";
  store.putAction(record);
}

export async function applyStoredAction(store: ConfluenceStore, id: number): Promise<void> {
  const record = store.getAction(id);
  if (!record) throw new Error(`Unknown action: ${id}`);
  await applyAction(store, record);
}

export function rejectStoredAction(store: ConfluenceStore, id: number): void | { restart?: boolean } {
  const record = store.getAction(id);
  if (!record) return;
  store.deleteAction(id);

  // Rejecting a creation invalidates any pending actions on that (now-nonexistent) content,
  // including child pages created under it, transitively. Cascade-delete and request a restart.
  if (record.action.type === "createContent") {
    const pending = store.pendingActions();
    const purge = new Set<string>([record.action.provisionalId]);
    for (;;) {
      let added = false;
      for (const r of pending) {
        if (r.action.type === "createContent" && r.action.parent.type === "page" &&
            purge.has(r.action.parent.parentId) && !purge.has(r.action.provisionalId)) {
          purge.add(r.action.provisionalId);
          added = true;
        }
      }
      if (!added) break;
    }
    let deleted = false;
    for (const r of pending) {
      const t = actionContentId(r.action);
      if (t !== null && purge.has(t)) {
        store.deleteAction(r.id);
        deleted = true;
      }
    }
    return deleted ? { restart: true } : undefined;
  }

  const target = actionContentId(record.action);
  if (target && store.pendingForContent(target).length > 0) return { restart: true };
}

type RevertResult = void | { message?: string; canRetry?: boolean; restart?: boolean };

export async function revertStoredAction(store: ConfluenceStore, id: number): Promise<RevertResult> {
  const record = store.getAction(id);
  if (!record) throw new Error(`Unknown action: ${id}`);

  const result = await revertAction(store, record);
  // A returned message means the undo couldn't be performed; leave the record applied. Otherwise it
  // was reverted, so drop it from the pending/applied set.
  if (!(result && "message" in result)) {
    record.state = "reverted";
    store.putAction(record);
  }
  return result;
}

async function revertAction(store: ConfluenceStore, record: StoredActionRecord): Promise<RevertResult> {
  const api = store.api;
  const action = record.action;

  switch (action.type) {
    case "createContent":
      if (record.createdContentId) await api.trashContent(record.createdContentId, action.kind);
      return;
    case "setContent":
    case "appendContent": {
      if (action.type === "appendContent" && action.previousMarkdown === undefined) {
        return { message: "Cannot automatically revert this append (the prior content was not captured)." };
      }
      const id2 = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id2, true);
      await api.updateContent({
        id: id2,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: current.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: markdownToStorage(action.previousMarkdown ?? ""),
        status: preservedStatus(current),
      });
      store.invalidateContent(id2);
      return;
    }
    case "setTitle": {
      const id2 = requireResolved(store, action.contentId);
      const current = await store.getContentResponse(id2, true);
      await api.updateContent({
        id: id2,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: action.previousTitle,
        version: (current.version?.number ?? 1) + 1,
        storageValue: current.body?.storage?.value ?? "",
        status: preservedStatus(current),
      });
      store.invalidateContent(id2);
      return;
    }
    case "addComment":
      if (record.createdContentId) await api.deleteComment(record.createdContentId);
      return;
    case "addLabel":
      await api.removeLabel(requireResolved(store, action.contentId), action.name);
      store.invalidateContent(action.contentId);
      return;
    case "removeLabel":
      await api.addLabel(requireResolved(store, action.contentId), action.name);
      store.invalidateContent(action.contentId);
      return;
    case "uploadAttachment":
      if (record.createdAttachmentId) await api.deleteAttachment(record.createdAttachmentId);
      return;
    case "trash":
      await api.restoreContent(requireResolved(store, action.contentId));
      store.invalidateContent(action.contentId);
      return;
    case "restore": {
      const id = requireResolved(store, action.contentId);
      await api.trashContent(id, await store.getContentKind(id));
      store.invalidateContent(action.contentId);
      return;
    }
  }
}

// Re-exports used by sessions for base reads.
export { contentBodyMarkdown, contentToSummary, storageToMarkdown };
