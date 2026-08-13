// Phase 2 machinery for the Notion gatekeeper: pending-action storage, provisional IDs for
// not-yet-created pages, response caching, action simulation (so reads reflect pending writes),
// and the apply/revert logic invoked by the gatekeeper DO.
//
// Design: we cache the *base* truth fetched from Notion (with a short TTL) and overlay the list of
// pending (submitted-but-not-yet-applied) actions at read time. submitAction() records an action
// and leaves the base cache untouched; applyAction() performs the real API call and invalidates the
// affected cache entries; rejectAction() simply drops the record so the overlay recomputes without
// it. This keeps cache and simulation cleanly separated.

import {
  NotionApi,
  blocksToMarkdown,
  iconInputToNotion,
  markdownToBlocks,
  notionUrlFromId,
  databaseSchema,
  pageToMetadata,
  pageToSummary,
  plainToRichText,
  primaryDataSourceId,
  propertiesToValues,
  propertyInputsToNotion,
  type BlockWithChildren,
  type NotionDataSourceResponse,
  type NotionDatabaseResponse,
  type NotionPageResponse,
} from "./notion-api";
import type { RpcStub } from "cloudflare:workers";
import type { ActionDescription, ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  NotionComment,
  NotionDatabaseSchema,
  NotionIconInput,
  NotionItemSummary,
  NotionPageMetadata,
  NotionPageSummary,
  NotionPropertyInput,
  NotionPropertyValue,
  NotionUser,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Action model

export type NotionActionParent =
  | { kind: "page"; pageId: string }
  | { kind: "database"; databaseId: string }
  | { kind: "workspace" };

export type NotionAction =
  | { type: "appendContent"; pageId: string; markdown: string }
  | { type: "setTitle"; pageId: string; title: string; previousTitle: string }
  | {
      type: "setProperties";
      pageId: string;
      properties: Record<string, NotionPropertyInput>;
      previousProperties: Record<string, NotionPropertyInput>;
    }
  | { type: "setIcon"; pageId: string; icon: NotionIconInput | null; previousIcon: NotionIconInput | null }
  | { type: "archive"; pageId: string }
  | { type: "restore"; pageId: string }
  | { type: "addComment"; pageId: string; text: string }
  | {
      type: "createPage";
      provisionalId: string;
      parent: NotionActionParent;
      title?: string;
      properties?: Record<string, NotionPropertyInput>;
      content?: string;
      icon?: NotionIconInput;
      /** The parent data source's title column name (e.g. "Name"), so simulated reads key the
       *  title correctly before approval. Absent for non-database parents. */
      titlePropertyName?: string;
    };

export type StoredActionRecord = {
  id: number;
  action: NotionAction;
  state: "pending" | "applied" | "reverted";
  submittedAt: number;
  /** For appendContent revert: the IDs of the blocks created on apply. */
  appendedBlockIds?: string[];
  /** For createPage: the real Notion page ID assigned on apply. */
  createdPageId?: string;
};

// The page (provisional or real) an action targets, or null for actions that don't target a page.
function actionPageId(action: NotionAction): string | null {
  if (action.type === "createPage") return action.provisionalId;
  return action.pageId;
}

// ---------------------------------------------------------------------------------------------
// Cache + pending-action storage (backed by the gatekeeper DO's KV storage)

type Kv = DurableObjectStorage["kv"];

const PAGE_TTL_MS = 30_000;
const CONTENT_TTL_MS = 30_000;
const DB_TTL_MS = 60_000;
const USER_TTL_MS = 60 * 60_000;

type PageCache = { fetchedAt: number; page: NotionPageResponse };
type ContentCache = { fetchedAt: number; markdown: string };
type DbCache = { fetchedAt: number; db: NotionDatabaseResponse };
type DataSourceCache = { fetchedAt: number; dataSource: NotionDataSourceResponse };

export class NotionStore {
  #kv: Kv;
  #api: NotionApi;

  constructor(kv: Kv, api: NotionApi) {
    this.#kv = kv;
    this.#api = api;
  }

  get api(): NotionApi {
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

  /**
   * Pending actions targeting a specific page, in submission order. The page may be addressed by
   * either its provisional id or its real id (the same page can be reached both ways once a creation
   * has been applied), so we compare *resolved* IDs on both sides.
   */
  pendingForPage(pageId: string): StoredActionRecord[] {
    const target = this.resolveId(pageId);
    return this.pendingActions().filter(r => {
      const t = actionPageId(r.action);
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

  /** Resolve a (possibly provisional) ID to a real Notion ID, if the creating action has applied. */
  resolveId(id: string): string {
    if (!NotionStore.isProvisional(id)) return id;
    return this.#kv.get<string>(`prov:${id}`) ?? id;
  }

  /**
   * True if this provisional ID belongs to a page created in this session (still pending or already
   * applied). Lets getPage() rehydrate a provisional handle.
   */
  knowsProvisional(id: string): boolean {
    if (this.resolveId(id) !== id) return true; // already applied -> real ID mapped
    return this.allActions().some(
      r => r.action.type === "createPage" && r.action.provisionalId === id);
  }

  /** The createPage action for a provisional ID, if any. */
  createActionFor(provisionalId: string): StoredActionRecord | undefined {
    return this.allActions().find(
      r => r.action.type === "createPage" && r.action.provisionalId === provisionalId);
  }

  // --- base data fetch with caching ---

  async getPageResponse(id: string, bypassCache = false): Promise<NotionPageResponse> {
    const realId = this.resolveId(id);
    if (!bypassCache) {
      const cached = this.#kv.get<PageCache>(`cache:page:${realId}`);
      if (cached && Date.now() - cached.fetchedAt < PAGE_TTL_MS) return cached.page;
    }
    const page = await this.#api.retrievePage(realId);
    this.#kv.put<PageCache>(`cache:page:${realId}`, { fetchedAt: Date.now(), page });
    return page;
  }

  async getPageContent(id: string): Promise<string> {
    const realId = this.resolveId(id);
    const cached = this.#kv.get<ContentCache>(`cache:content:${realId}`);
    if (cached && Date.now() - cached.fetchedAt < CONTENT_TTL_MS) return cached.markdown;
    const tree = await this.#api.fetchBlockTree(realId);
    const markdown = blocksToMarkdown(tree);
    this.#kv.put<ContentCache>(`cache:content:${realId}`, { fetchedAt: Date.now(), markdown });
    return markdown;
  }

  /**
   * Resolve a user to its full form (name/avatar/email), cached — page metadata only includes
   * partial `{id}` users, unlike property values.
   */
  async getUser(id: string): Promise<NotionUser> {
    const cached = this.#kv.get<{ fetchedAt: number; user: NotionUser }>(`cache:user:${id}`);
    if (cached && Date.now() - cached.fetchedAt < USER_TTL_MS) return cached.user;
    const user = await this.#api.retrieveUser(id);
    this.#kv.put(`cache:user:${id}`, { fetchedAt: Date.now(), user });
    return user;
  }

  async getDatabaseResponse(id: string): Promise<NotionDatabaseResponse> {
    const realId = this.resolveId(id);
    const cached = this.#kv.get<DbCache>(`cache:db:${realId}`);
    if (cached && Date.now() - cached.fetchedAt < DB_TTL_MS) return cached.db;
    const db = await this.#api.retrieveDatabase(realId);
    this.#kv.put<DbCache>(`cache:db:${realId}`, { fetchedAt: Date.now(), db });
    return db;
  }

  /** The primary data source ID for a database (cached via the database response). */
  async getDataSourceId(databaseId: string): Promise<string> {
    return primaryDataSourceId(await this.getDatabaseResponse(databaseId));
  }

  async getDataSourceResponse(dataSourceId: string): Promise<NotionDataSourceResponse> {
    const cached = this.#kv.get<DataSourceCache>(`cache:ds:${dataSourceId}`);
    if (cached && Date.now() - cached.fetchedAt < DB_TTL_MS) return cached.dataSource;
    const dataSource = await this.#api.retrieveDataSource(dataSourceId);
    this.#kv.put<DataSourceCache>(`cache:ds:${dataSourceId}`, { fetchedAt: Date.now(), dataSource });
    return dataSource;
  }

  /** The row schema for a database, read from its primary data source. */
  async getDatabaseSchema(databaseId: string): Promise<NotionDatabaseSchema> {
    const dataSourceId = await this.getDataSourceId(databaseId);
    return databaseSchema(await this.getDataSourceResponse(dataSourceId));
  }

  invalidatePage(id: string): void {
    const realId = this.resolveId(id);
    this.#kv.delete(`cache:page:${realId}`);
  }

  invalidateContent(id: string): void {
    const realId = this.resolveId(id);
    this.#kv.delete(`cache:content:${realId}`);
  }

  invalidateDatabase(id: string): void {
    const realId = this.resolveId(id);
    this.#kv.delete(`cache:db:${realId}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Conversions used by simulation

// The empty/default value Notion gives a column when a row is created without setting it, so a
// pending row's property set matches the shape of an approved row.
function defaultValueForType(type: NotionPropertyValue["type"]): NotionPropertyValue {
  switch (type) {
    case "title": return { type: "title", text: "" };
    case "rich_text": return { type: "rich_text", text: "" };
    case "number": return { type: "number", number: null };
    case "select": return { type: "select", option: null };
    case "multi_select": return { type: "multi_select", options: [] };
    case "status": return { type: "status", status: null };
    case "date": return { type: "date", start: null, end: null };
    case "checkbox": return { type: "checkbox", checked: false };
    case "url": return { type: "url", url: null };
    case "email": return { type: "email", email: null };
    case "phone_number": return { type: "phone_number", phoneNumber: null };
    case "people": return { type: "people", people: [] };
    case "relation": return { type: "relation", pageIds: [] };
    case "files": return { type: "files", files: [] };
    case "formula": return { type: "formula", value: null };
    case "rollup": return { type: "rollup", summary: "" };
    case "unique_id": return { type: "unique_id", value: "" };
    case "created_time": return { type: "created_time", time: new Date() };
    case "last_edited_time": return { type: "last_edited_time", time: new Date() };
    case "created_by": return { type: "created_by", user: null };
    case "last_edited_by": return { type: "last_edited_by", user: null };
    default: return { type: "unsupported", rawType: String(type) };
  }
}

/**
 * All columns of a schema with their default (empty) values, used to seed a pending row so it has
 * the same property keys an approved row would.
 */
export function defaultPropertiesFromSchema(schema: NotionDatabaseSchema): Record<string, NotionPropertyValue> {
  const props: Record<string, NotionPropertyValue> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    props[name] = defaultValueForType(prop.type as NotionPropertyValue["type"]);
  }
  return props;
}

// Convert a writable property input into the read value shape, so simulated reads look like real
// ones.
function inputToValue(input: NotionPropertyInput): NotionPropertyValue {
  switch (input.type) {
    case "title":
      return { type: "title", text: input.text };
    case "rich_text":
      return { type: "rich_text", text: input.text };
    case "number":
      return { type: "number", number: input.number };
    case "select":
      return { type: "select", option: input.option };
    case "multi_select":
      return { type: "multi_select", options: input.options };
    case "status":
      return { type: "status", status: input.status };
    case "date":
      return { type: "date", start: input.start, end: input.end ?? null };
    case "checkbox":
      return { type: "checkbox", checked: input.checked };
    case "url":
      return { type: "url", url: input.url };
    case "email":
      return { type: "email", email: input.email };
    case "phone_number":
      return { type: "phone_number", phoneNumber: input.phoneNumber };
    case "people":
      return { type: "people", people: input.userIds.map(id => ({ id })) };
    case "relation":
      return { type: "relation", pageIds: input.pageIds };
    case "files":
      return { type: "files", files: input.files };
  }
}

// ---------------------------------------------------------------------------------------------
// Simulation: overlay pending actions onto base reads.

// Returns the effective archived state implied by pending archive/restore actions, or undefined if
// none touch it.
function pendingArchivedState(records: StoredActionRecord[]): boolean | undefined {
  let state: boolean | undefined;
  for (const r of records) {
    if (r.action.type === "archive") state = true;
    else if (r.action.type === "restore") state = false;
  }
  return state;
}

/** Simulated page metadata. `base` is null for a provisional page that doesn't exist on Notion yet. */
export function simulatePageMetadata(
  base: NotionPageMetadata | null,
  pageId: string,
  records: StoredActionRecord[],
): NotionPageMetadata {
  let meta: NotionPageMetadata;
  if (base) {
    meta = { ...base };
  } else {
    const create = records.find(r => r.action.type === "createPage");
    const action = create?.action.type === "createPage" ? create.action : undefined;
    meta = {
      id: pageId,
      title: action?.title ?? "",
      url: notionUrlFromId(pageId),
      parent:
        action?.parent.kind === "page" ? { type: "page", pageId: action.parent.pageId }
        : action?.parent.kind === "database" ? { type: "database", databaseId: action.parent.databaseId }
        : { type: "workspace" },
      createdAt: new Date(create?.submittedAt ?? Date.now()),
      lastEditedAt: new Date(create?.submittedAt ?? Date.now()),
      createdBy: null,
      lastEditedBy: null,
      archived: false,
      locked: false,
    };
    if (action?.icon) meta.icon = iconInputDisplay(action.icon);
  }
  for (const r of records) {
    const a = r.action;
    if (a.type === "setIcon") meta.icon = a.icon ? iconInputDisplay(a.icon) : undefined;
    else if (a.type === "archive") meta.archived = true;
    else if (a.type === "restore") meta.archived = false;
  }
  // Title can be set via setTitle, the create `title`, or a title-typed property; derive it uniformly.
  meta.title = simulatedTitle(records, meta.title);
  return meta;
}

/**
 * The effective page title after applying pending records, considering every way a title can be
 * set: setTitle(), createPage `title`, and a `title`-typed property in createPage/setProperties.
 */
export function simulatedTitle(records: StoredActionRecord[], baseTitle: string): string {
  let title = baseTitle;
  for (const r of records) {
    const a = r.action;
    if (a.type === "setTitle") {
      title = a.title;
    } else if (a.type === "createPage") {
      if (a.title !== undefined) title = a.title;
      const tp = Object.values(a.properties ?? {}).find(p => p.type === "title");
      if (tp && tp.type === "title") title = tp.text;
    } else if (a.type === "setProperties") {
      const tp = Object.values(a.properties).find(p => p.type === "title");
      if (tp && tp.type === "title") title = tp.text;
    }
  }
  return title;
}

function iconInputDisplay(icon: NotionIconInput): string {
  return "emoji" in icon ? icon.emoji : icon.imageUrl;
}

/**
 * Simulated page property values. For a provisional page (`base` null), `seed` supplies the
 * parent database's full column set with default values so the shape matches an approved row.
 */
export function simulatePageProperties(
  base: Record<string, NotionPropertyValue> | null,
  records: StoredActionRecord[],
  seed?: Record<string, NotionPropertyValue>,
): Record<string, NotionPropertyValue> {
  const props: Record<string, NotionPropertyValue> = base ? { ...base } : { ...seed };
  // The title column name for a provisional row: prefer the create action's recorded data-source
  // title column (e.g. "Name") so the simulated shape matches the post-approval shape.
  const create = records.find(r => r.action.type === "createPage");
  const titleKey = create?.action.type === "createPage" ? create.action.titlePropertyName : undefined;
  // Seed provisional pages from their create action.
  if (!base && create?.action.type === "createPage") {
    for (const [name, input] of Object.entries(create.action.properties ?? {})) {
      props[name] = inputToValue(input);
    }
    if (create.action.title !== undefined) setTitleValue(props, create.action.title, titleKey);
  }
  for (const r of records) {
    const a = r.action;
    if (a.type === "setProperties") {
      for (const [name, input] of Object.entries(a.properties)) props[name] = inputToValue(input);
    } else if (a.type === "setTitle") {
      setTitleValue(props, a.title, titleKey);
    }
  }
  return props;
}

function setTitleValue(
  props: Record<string, NotionPropertyValue>,
  title: string,
  titleKey?: string,
): void {
  const entry = Object.entries(props).find(([, v]) => v.type === "title");
  if (entry) props[entry[0]] = { type: "title", text: title };
  else props[titleKey ?? "title"] = { type: "title", text: title };
}

// Run Markdown through the same Markdown -> Notion blocks -> Markdown round-trip that an apply +
// read-back would, so the simulation reflects the (lossy) conversion (heading clamp, `*` -> `-`,
// nested lists flattened, tables/blank lines collapsed, etc.) rather than echoing the raw input.
function normalizeAppendedMarkdown(markdown: string): string {
  const blocks = markdownToBlocks(markdown) as Array<Record<string, unknown>>;
  return blocksToMarkdown(blocks.map(block => ({ block: block as BlockWithChildren["block"] })));
}

/** Simulated page body Markdown. */
export function simulatePageContent(
  base: string | null,
  records: StoredActionRecord[],
): string {
  const parts: string[] = [];
  if (base) parts.push(base);
  for (const r of records) {
    const a = r.action;
    if (a.type === "createPage" && !base && a.content) parts.push(normalizeAppendedMarkdown(a.content));
    else if (a.type === "appendContent") parts.push(normalizeAppendedMarkdown(a.markdown));
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Simulated comment list (base comments plus pending ones). */
export function simulateComments(
  base: NotionComment[],
  records: StoredActionRecord[],
): NotionComment[] {
  const out = [...base];
  for (const r of records) {
    if (r.action.type === "addComment") {
      out.push({
        id: `~comment-${r.id}`,
        text: r.action.text,
        author: null,
        createdAt: new Date(r.submittedAt),
      });
    }
  }
  return out;
}

// Build a page summary for a pending (not-yet-created) page, folding in any subsequent pending
// edits to that provisional page (setProperties/setTitle) so the row reflects the latest state.
function createdPageSummary(
  record: StoredActionRecord,
  store: NotionStore,
  seed?: Record<string, NotionPropertyValue>,
): NotionPageSummary {
  const action = record.action;
  if (action.type !== "createPage") throw new Error("not a createPage action");
  const records = store.pendingForPage(action.provisionalId);
  const properties = simulatePageProperties(null, records, seed);
  const meta = simulatePageMetadata(null, action.provisionalId, records);
  return {
    id: action.provisionalId,
    title: meta.title,
    url: notionUrlFromId(action.provisionalId),
    createdAt: new Date(record.submittedAt),
    lastEditedAt: new Date(meta.lastEditedAt.getTime()),
    properties,
  };
}

// Pending records targeting a given real page ID, resolving provisional IDs so that edits queued
// against a now-applied creation still match the real row.
function recordsTargeting(
  store: NotionStore,
  pending: StoredActionRecord[],
  realId: string,
): StoredActionRecord[] {
  return pending.filter(r => {
    const target = actionPageId(r.action);
    return target !== null && store.resolveId(target) === realId;
  });
}

// The pending createPage actions in scope for a list overlay, excluding ones the session also
// archived while pending.
function createdInScope(
  store: NotionStore,
  predicate: (action: Extract<NotionAction, { type: "createPage" }>) => boolean,
): StoredActionRecord[] {
  return store.pendingActions().filter(r => {
    if (r.action.type !== "createPage" || !predicate(r.action)) return false;
    return pendingArchivedState(store.pendingForPage(r.action.provisionalId)) !== true;
  });
}

/**
 * Overlay pending changes onto a batch of database query rows. `firstPage` controls whether
 * pending newly-created rows are prepended (only on the first page, to avoid duplication).
 *
 * NOTE: pending created rows ignore the query's filter and sort — they are always surfaced so the
 * agent sees its own writes. This is a documented simulation limitation.
 */
export function overlayDatabaseRows(
  rows: NotionPageSummary[],
  databaseId: string,
  store: NotionStore,
  firstPage: boolean,
  seed?: Record<string, NotionPropertyValue>,
): NotionPageSummary[] {
  const pending = store.pendingActions();
  let result = rows.map(row => {
    const records = recordsTargeting(store, pending, row.id);
    if (records.length === 0) return row;
    return {
      ...row,
      title: simulatedTitle(records, row.title),
      properties: simulatePageProperties(row.properties, records),
    };
  });
  // Drop rows archived while pending.
  result = result.filter(row => pendingArchivedState(recordsTargeting(store, pending, row.id)) !== true);
  if (firstPage) {
    const created = createdInScope(
      store,
      a => a.parent.kind === "database" && a.parent.databaseId === databaseId,
    ).map(r => createdPageSummary(r, store, seed));
    result = [...created, ...result];
  }
  return result;
}

/** Overlay pending child pages created under a page (and drop pending-archived children). */
export function overlayChildPages(
  items: NotionItemSummary[],
  parentPageId: string,
  store: NotionStore,
  firstPage: boolean,
): NotionItemSummary[] {
  const pending = store.pendingActions();
  let result = items.filter(
    item => pendingArchivedState(recordsTargeting(store, pending, item.id)) !== true,
  );
  if (firstPage) {
    const created = createdInScope(
      store,
      a => a.parent.kind === "page" && store.resolveId(a.parent.pageId) === store.resolveId(parentPageId),
    ).map(r => itemFromCreated(createdPageSummary(r, store)));
    result = [...created, ...result];
  }
  return result;
}

function itemFromCreated(summary: NotionPageSummary): NotionItemSummary {
  return {
    kind: "page",
    id: summary.id,
    title: summary.title,
    url: summary.url,
    createdAt: summary.createdAt,
    lastEditedAt: summary.lastEditedAt,
  };
}

/**
 * Overlay pending changes onto search results: drop pending-archived items, and prepend pending
 * created pages (only when the caller isn't filtering to databases, since created items are pages).
 */
export function overlaySearch(
  items: NotionItemSummary[],
  store: NotionStore,
  firstPage: boolean,
  kindFilter?: "page" | "database",
): NotionItemSummary[] {
  const pending = store.pendingActions();
  let result = items.map(item => {
    const records = recordsTargeting(store, pending, item.id);
    return records.length ? { ...item, title: simulatedTitle(records, item.title) } : item;
  });
  result = result.filter(
    item => pendingArchivedState(recordsTargeting(store, pending, item.id)) !== true,
  );
  if (firstPage && kindFilter !== "database") {
    const created = createdInScope(store, () => true).map(r => itemFromCreated(createdPageSummary(r, store)));
    result = [...created, ...result];
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Observation descriptions

export function observation(title: string, description: string): ObservationDescription {
  return { title, description };
}

// ---------------------------------------------------------------------------------------------
// Action descriptions

export function describeAction(action: NotionAction): ActionDescription {
  switch (action.type) {
    case "appendContent":
      return {
        title: "Append content to Notion page",
        description: `Append the following Markdown to the page body:\n\n${truncate(action.markdown)}`,
        implementsRevert: true,
      };
    case "setTitle":
      return {
        title: "Rename Notion page",
        description: `Change the page title to **${action.title}** (was “${action.previousTitle}”).`,
        implementsRevert: true,
      };
    case "setProperties":
      return {
        title: "Update Notion page properties",
        description: `Update properties: ${Object.keys(action.properties).join(", ") || "(none)"}.`,
        implementsRevert: true,
      };
    case "setIcon":
      return {
        title: "Change Notion page icon",
        description: action.icon
          ? `Set the page icon to ${iconInputDisplay(action.icon)}.`
          : "Remove the page icon.",
        implementsRevert: true,
      };
    case "archive":
      return {
        title: "Move Notion page to trash",
        description: "Move the page to the Notion trash (reversible).",
        implementsRevert: true,
      };
    case "restore":
      return {
        title: "Restore Notion page from trash",
        description: "Restore the page from the Notion trash.",
        implementsRevert: true,
      };
    case "addComment":
      return {
        title: "Comment on Notion page",
        description: `Post a comment:\n\n${truncate(action.text)}`,
        // The Notion public API can't delete comments, so this can't be reverted automatically.
        implementsRevert: false,
      };
    case "createPage": {
      const where =
        action.parent.kind === "page" ? "as a sub-page"
        : action.parent.kind === "database" ? "as a database row"
        // Workspace-level: the API needs a concrete parent, so the page lands under the most
        // recently edited shared page (chosen when this action is approved).
        : "under the most recently edited shared page (Notion has no true top-level page)";
      return {
        title: "Create Notion page",
        description: `Create a new page ${where} titled **${action.title ?? "Untitled"}**.`,
        implementsRevert: true,
      };
    }
  }
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ---------------------------------------------------------------------------------------------
// Apply / revert

/**
 * Apply a previously-submitted action against Notion. Mutates and persists the record (e.g. to
 * store created IDs for later revert). Throws on failure (the overseer surfaces this to the user).
 */
export async function applyNotionAction(store: NotionStore, record: StoredActionRecord): Promise<void> {
  const api = store.api;
  const action = record.action;

  switch (action.type) {
    case "appendContent": {
      const pageId = requireResolved(store, action.pageId);
      const ids = await api.appendBlockChildren(pageId, markdownToBlocks(action.markdown));
      record.appendedBlockIds = ids;
      // Persist the revert info immediately so a crash before the end of this function can't lose
      // the IDs of the blocks we just created (which we need to revert the append).
      store.putAction(record);
      store.invalidateContent(action.pageId);
      break;
    }
    case "setTitle": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { properties: { [await titlePropName(store, action.pageId)]: { title: plainToRichText(action.title) } } });
      store.invalidatePage(action.pageId);
      break;
    }
    case "setProperties": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { properties: propertyInputsToNotion(action.properties) });
      store.invalidatePage(action.pageId);
      break;
    }
    case "setIcon": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { icon: action.icon ? iconInputToNotion(action.icon) : null });
      store.invalidatePage(action.pageId);
      break;
    }
    case "archive": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { archived: true });
      store.invalidatePage(action.pageId);
      break;
    }
    case "restore": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { archived: false });
      store.invalidatePage(action.pageId);
      break;
    }
    case "addComment": {
      const pageId = requireResolved(store, action.pageId);
      await api.createComment({ parent: { page_id: pageId }, rich_text: plainToRichText(action.text) });
      break;
    }
    case "createPage": {
      const parent = await resolveCreateParent(store, action.parent);
      const body = buildCreateBody(
        parent, action.title, action.properties, action.content, action.icon, action.titlePropertyName);
      const page = await api.createPage(body);
      record.createdPageId = page.id;
      // Persist the real ID immediately — a crash before the end of this function would otherwise
      // orphan the just-created Notion page (no record of it to revert).
      store.putAction(record);
      store.setProvisional(action.provisionalId, page.id);
      break;
    }
  }

  record.state = "applied";
  store.putAction(record);
}

/** Revert a previously-applied action. Returns guidance if the revert can't fully complete. */
export async function revertNotionAction(
  store: NotionStore,
  record: StoredActionRecord,
): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
  const api = store.api;
  const action = record.action;

  // For actions that revert by restoring a captured "previous" value, refuse if a newer *still-
  // applied* action touched an overlapping field on the same page — restoring would clobber it. The
  // user must revert the newer change(s) first (a successful revert clears the "applied" flag, so
  // reverting newest-first works).
  if (laterConflictingApplied(store, record)) {
    return {
      message:
        "A newer change was applied to this page after this action. Revert the newer change(s) " +
        "first, then retry — reverting now would overwrite them.",
      canRetry: true,
    };
  }

  switch (action.type) {
    case "appendContent": {
      for (const blockId of record.appendedBlockIds ?? []) {
        await api.deleteBlock(blockId);
      }
      store.invalidateContent(action.pageId);
      break;
    }
    case "setTitle": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { properties: { [await titlePropName(store, action.pageId)]: { title: plainToRichText(action.previousTitle) } } });
      store.invalidatePage(action.pageId);
      break;
    }
    case "setProperties": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { properties: propertyInputsToNotion(action.previousProperties) });
      store.invalidatePage(action.pageId);
      break;
    }
    case "setIcon": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { icon: action.previousIcon ? iconInputToNotion(action.previousIcon) : null });
      store.invalidatePage(action.pageId);
      break;
    }
    case "archive": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { archived: false });
      store.invalidatePage(action.pageId);
      break;
    }
    case "restore": {
      const pageId = requireResolved(store, action.pageId);
      await api.updatePage(pageId, { archived: true });
      store.invalidatePage(action.pageId);
      break;
    }
    case "createPage": {
      if (record.createdPageId) {
        await api.updatePage(record.createdPageId, { archived: true });
        store.invalidatePage(record.createdPageId);
      }
      break;
    }
    case "addComment":
      // Can't be undone via the API; leave the record applied so it isn't treated as reverted.
      return { message: "Notion comments can't be deleted through the API; please remove the comment manually." };
  }

  // Mark the action reverted so it no longer blocks reverting earlier actions on the same page.
  record.state = "reverted";
  store.putAction(record);
}

// The set of logical fields an action mutates (for revert conflict detection). Actions that only
// add content (append/comment/create) return an empty set — reverting them never clobbers a field.
function mutatedFields(action: NotionAction): string[] {
  switch (action.type) {
    case "setTitle": return ["title"];
    case "setProperties": return ["title", "props"]; // may include the title property
    case "setIcon": return ["icon"];
    case "archive":
    case "restore": return ["archived"];
    default: return [];
  }
}

// True if a later (higher-ID) still-applied action mutated a field overlapping this action's, on the
// same page. Compares *resolved* IDs so an edit made through the provisional-id session and one made
// through a real-id session (after the page was created) are recognized as the same page.
// Successful reverts clear the "applied" state, so they stop counting here.
function laterConflictingApplied(store: NotionStore, record: StoredActionRecord): boolean {
  const fields = new Set(mutatedFields(record.action));
  if (fields.size === 0) return false;
  const rawTarget = actionPageId(record.action);
  if (!rawTarget) return false;
  const target = store.resolveId(rawTarget);
  return store.allActions().some(r => {
    if (r.id <= record.id || r.state !== "applied") return false;
    const t = actionPageId(r.action);
    if (t === null || store.resolveId(t) !== target) return false;
    return mutatedFields(r.action).some(f => fields.has(f));
  });
}

// ---------------------------------------------------------------------------------------------
// Apply helpers

function requireResolved(store: NotionStore, id: string): string {
  const resolved = store.resolveId(id);
  if (NotionStore.isProvisional(resolved)) {
    throw new Error(
      `Cannot apply this action yet: it targets a page (${id}) whose creation has not been ` +
      `approved. Approve the page creation first.`,
    );
  }
  return resolved;
}

type NotionCreateParent =
  | { type: "page_id"; page_id: string }
  | { type: "data_source_id"; data_source_id: string };

async function resolveCreateParent(
  store: NotionStore,
  parent: NotionActionParent,
): Promise<NotionCreateParent> {
  if (parent.kind === "page") {
    return { type: "page_id", page_id: requireResolved(store, parent.pageId) };
  }
  if (parent.kind === "database") {
    // A database row's parent is its data source (works on any API version).
    const databaseId = requireResolved(store, parent.databaseId);
    return { type: "data_source_id", data_source_id: await store.getDataSourceId(databaseId) };
  }
  // Workspace-level: the Notion API needs a concrete parent, so pick the most recently edited
  // shared page to create under.
  const search = await store.api.search({
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 1,
  });
  const parentPage = search.results[0];
  if (!parentPage) {
    throw new Error(
      "No writable Notion page is shared with this connection to create the page under.",
    );
  }
  return { type: "page_id", page_id: parentPage.id };
}

async function titlePropName(store: NotionStore, pageId: string): Promise<string> {
  const page = await store.getPageResponse(pageId, true);
  const entry = Object.entries(page.properties ?? {}).find(([, p]) => p.type === "title");
  return entry ? entry[0] : "title";
}

export function buildCreateBody(
  parent: NotionCreateParent,
  title: string | undefined,
  properties: Record<string, NotionPropertyInput> | undefined,
  content: string | undefined,
  icon: NotionIconInput | undefined,
  titlePropertyName?: string,
): Record<string, unknown> {
  const notionProperties: Record<string, unknown> = properties
    ? propertyInputsToNotion(properties)
    : {};

  if (title !== undefined) {
    if (parent.type === "page_id") {
      notionProperties["title"] = { title: plainToRichText(title) };
    } else {
      const hasTitle = properties ? Object.values(properties).some(p => p.type === "title") : false;
      // Use the data source's actual title column name when known, else fall back to "Name".
      if (!hasTitle) notionProperties[titlePropertyName ?? "Name"] = { title: plainToRichText(title) };
    }
  }

  const body: Record<string, unknown> = { parent, properties: notionProperties };
  if (icon) body["icon"] = iconInputToNotion(icon);
  if (content) body["children"] = markdownToBlocks(content);
  return body;
}

/**
 * Record a pending action and submit it to the approval queue for later approval. If the submit
 * fails, the stored record is rolled back so it doesn't pollute simulation. Returns the action ID.
 */
export async function stageAction(
  store: NotionStore,
  approvalQueue: RpcStub<ApprovalQueue>,
  action: NotionAction,
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
// Overseer-facing dispatch (called by the gatekeeper DO's applyAction/rejectAction/revertAction).

export async function applyStoredAction(store: NotionStore, id: number): Promise<void> {
  const record = store.getAction(id);
  if (!record) throw new Error(`Unknown action: ${id}`);
  await applyNotionAction(store, record);
}

export function rejectStoredAction(store: NotionStore, id: number): void | { restart?: boolean } {
  const record = store.getAction(id);
  if (!record) return;
  store.deleteAction(id);

  // Rejecting a page creation invalidates every pending action that targeted that provisional page
  // (they could never be applied — the page won't exist), including sub-pages created under it and
  // their edits, transitively. Cascade-delete them all so the overseer never tries to apply an
  // orphan, and request a restart since the Gadget already observed simulated state built on them.
  if (record.action.type === "createPage") {
    // Snapshot the pending set once — deleting actions below would otherwise change it under us.
    const pending = store.pendingActions();
    const purge = new Set<string>([record.action.provisionalId]);
    // Expand to transitively-nested sub-page creations. Only `createSubPage` nests a creation under
    // a provisional page (parent.kind === "page"); database/workspace creates never have a
    // provisional parent, so they don't need handling here.
    for (;;) {
      let added = false;
      for (const r of pending) {
        if (r.action.type === "createPage" && r.action.parent.kind === "page" &&
            purge.has(r.action.parent.pageId) && !purge.has(r.action.provisionalId)) {
          purge.add(r.action.provisionalId);
          added = true;
        }
      }
      if (!added) break;
    }
    let deleted = false;
    for (const r of pending) {
      const t = actionPageId(r.action);
      if (t !== null && purge.has(t)) {
        store.deleteAction(r.id);
        deleted = true;
      }
    }
    if (deleted) return { restart: true };
    return;
  }

  // Rejecting a mid-stack edit leaves the simulated overlay the Gadget already observed
  // inconsistent; ask for a restart if other pending actions still target the same page.
  const target = actionPageId(record.action);
  if (target && store.pendingForPage(target).length > 0) {
    return { restart: true };
  }
}

export async function revertStoredAction(
  store: NotionStore,
  id: number,
): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
  const record = store.getAction(id);
  if (!record) throw new Error(`Unknown action: ${id}`);
  return await revertNotionAction(store, record);
}

// Re-exports used by sessions for base reads.
export { pageToMetadata, pageToSummary, propertiesToValues };
