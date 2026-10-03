import { isObservationRefused } from "@gadgets/gatekeeper-kit/observers";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CursorPager, type Pager } from "./cursor";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE, MAX_QUERY_PARENTS, isListableFolderFile,
  isListableFolderNode,
  type DriveApi, type DriveFile, type DriveListFilesOptions, type DriveScopeNode,
} from "./drive-api";
import {
  isDirectChild, outsideScope, readFolderLocation,
  type FolderLocation,
} from "./drive-folder-scope";
import type { DriveObservation } from "./drive-observers";
import type { ObserverCheck } from "./observers";
import type {
  DriveEntry, DriveFolderListOptions, DriveFolderSearchQuery, DriveListOptions, DriveOrder,
  DriveScope, DriveSearchQuery,
} from "./drive-types";

const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
/** Exact MIME type for native Google Docs files. */
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
/** Exact MIME type for native Google Sheets files. */
export const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

const FOLDER_MOVED = "The connected Drive folder moved to another drive; open a new listing.";

// Agent-supplied query values go in the approval description, so each value and the whole string
// are capped. They are not logged and they stay out of the title.
const MAX_OBSERVATION_VALUE = 32;
const MAX_OBSERVATION_DESCRIPTION = 240;

/** Immutable authority carried by one Drive gatekeeper binding. */
export type DriveBindingScope =
  | { kind: "account" }
  | { kind: "folder"; folderId: string }
  | { kind: "file"; fileId: string };

/**
 * Refuses a binding whose persisted scope predates this model rather than widening it: an
 * unrecognized kind would fall through every narrow check and be served as account scope.
 */
export function requireDriveBindingScope(scope: DriveBindingScope): DriveBindingScope {
  switch (scope.kind) {
    case "account":
    case "folder":
    case "file":
      return scope;
  }
  throw new Error(
    "This Google Drive connection predates the current folder resource. Remove it and connect " +
    "the folder or shared drive again.");
}

type DriveSessionScope = Exclude<DriveBindingScope, { kind: "folder" }>;
type DriveSessionApi = Pick<DriveApi, "listFiles" | "getFile" | "getScopeNodes">;
/** A page's proven scope: the bound drive, and the parents its files must sit directly under. */
type FolderPageScope = {driveId: string | undefined; parents: DriveScopeNode[]};

/** An observation description before scope enforcement supplies the observer exclusions. */
export type NativeObservation = Omit<ObservationDescription, "excludeObservers">;

/**
 * Performs one native Docs or Sheets read and authorizes it before the value is disclosed.
 *
 * The fetch is a thunk rather than a value so a scope check can refuse before the provider is
 * contacted at all.
 */
export type NativeRead = <T>(
  fetch: () => Promise<T>,
  observe: (value: T) => NativeObservation,
) => Promise<T>;

/** Reads and authorizes with no live scope check, for a binding whose scope cannot move. */
export function unguardedNativeRead(
  authorize: (description: ObservationDescription) => Promise<void>,
): NativeRead {
  return async <T>(fetch: () => Promise<T>, observe: (value: T) => NativeObservation) => {
    let value = await fetch();
    await authorize(observe(value));
    return value;
  };
}

/**
 * Everything one Drive session core enforces and reports through.
 *
 * `authorize` is part of the construction because it is the one thing that differs between the
 * cores a session builds: they share its scope and observer tracking, but a capability handed to
 * the caller -- a cursor, a native child -- authorizes through an approval queue with its own
 * lifetime.
 */
export type DriveSessionCoreOptions = {
  api: DriveSessionApi;
  scope: DriveSessionScope;
  prepareObservation(observations: DriveObservation[]): Promise<ObserverCheck<DriveObservation>>;
  /** Fences an owner-only observation: excludes today's observers and closes admission. */
  prepareWithheld(): ObserverCheck<DriveObservation>;
  authorize(description: ObservationDescription): Promise<void>;
};

/** Construction contract for one positioned folder capability core. */
export type DriveFolderSessionCoreOptions = Omit<DriveSessionCoreOptions, "scope"> & {
  location: FolderLocation;
};

/** Either core a Drive session can be driving. */
export type DriveCore = DriveSessionCore | DriveFolderSessionCore;

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Google Drive omitted required file ${field}`);
  return value;
}

/** Drive's `modifiedTime`, validated. */
export function driveModifiedTime(file: DriveFile): Date {
  let modifiedTime = new Date(requiredString(file.modifiedTime, "modifiedTime"));
  if (Number.isNaN(modifiedTime.valueOf())) {
    throw new Error("Google Drive returned an invalid modifiedTime");
  }
  return modifiedTime;
}

/** Maps one validated provider file to the permanent agent-facing declaration. */
export function driveFileToEntry(file: DriveFile): DriveEntry {
  let mimeType = requiredString(file.mimeType, "mimeType");
  let isFolder = mimeType === FOLDER_MIME_TYPE;
  let isShortcut = mimeType === SHORTCUT_MIME_TYPE;
  let modifiedTime = driveModifiedTime(file);

  let size: number | undefined;
  if (file.size !== undefined && !isFolder && !isShortcut) {
    size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Google Drive returned an invalid file size");
    }
  }
  let owner = file.driveId ? undefined : file.owners?.[0];
  let shortcut: DriveEntry["shortcut"];
  if (isShortcut && file.shortcutDetails) {
    shortcut = {
      targetId: requiredString(file.shortcutDetails.targetId, "shortcut targetId"),
      ...(file.shortcutDetails.targetMimeType ?
        { targetMimeType: file.shortcutDetails.targetMimeType } : {}),
    };
  }
  return {
    id: file.id,
    name: file.name,
    mimeType,
    isFolder,
    modifiedTime,
    ...(size === undefined ? {} : { size }),
    ...(owner ? {
      owner: {
        ...(owner.displayName ? { displayName: owner.displayName } : {}),
        ...(owner.emailAddress ? { emailAddress: owner.emailAddress } : {}),
      },
    } : {}),
    ...(file.parents?.[0] ? { parentId: file.parents[0] } : {}),
    ...(file.driveId ? { driveId: file.driveId } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
    ...(shortcut ? { shortcut } : {}),
  };
}

const ORDER_BY: Record<DriveOrder, string> = {
  modifiedTimeDesc: "modifiedTime desc",
  modifiedTimeAsc: "modifiedTime",
  nameAsc: "name",
  nameDesc: "name desc",
};

function orderBy(order: DriveOrder | undefined): string {
  if (order === undefined) return ORDER_BY.modifiedTimeDesc;
  let result = ORDER_BY[order];
  if (!result) throw new Error(`Unsupported Drive order: ${order}`);
  return result;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function timestamp(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an RFC 3339 timestamp`);
  }
  return value;
}

/**
 * A supplied parent is a narrowing the caller asked for, so a blank one is refused.
 *
 * Dropping it as if it were absent widens the read to the whole binding, which is the opposite of
 * what was asked; a blank name or text filter only matches more within the same scope.
 */
function narrowingParentId(directParentId?: string): string | undefined {
  if (directParentId === undefined) return undefined;
  let trimmed = directParentId.trim();
  if (!trimmed) {
    throw new Error("directParentId must not be blank; omit it to read the whole binding.");
  }
  return trimmed;
}

/**
 * Like {@link narrowingParentId}: a set naming nothing would widen the search, so it is refused.
 *
 * Checked here as well as in the query builder so a caller learns synchronously rather than from
 * the first page of a cursor it already holds.
 */
function narrowingChildFolderIds(ids?: readonly string[]): string[] | undefined {
  if (ids === undefined) return undefined;
  let trimmed = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
  if (!trimmed.length) {
    throw new Error("childFolderIds must name at least one folder; omit it to search this folder.");
  }
  if (trimmed.length > MAX_QUERY_PARENTS) {
    throw new Error(
      `childFolderIds accepts at most ${MAX_QUERY_PARENTS} folders; search them in batches.`);
  }
  return trimmed;
}

function normalizeSearch(query: DriveSearchQuery): DriveSearchQuery {
  let namePrefix = query.namePrefix?.trim();
  let fullTextContains = query.fullTextContains?.trim();
  let directParentId = narrowingParentId(query.directParentId);
  let mimeTypes = query.mimeTypes?.map(value => value.trim()).filter(Boolean);
  let modifiedAfter = query.modifiedAfter
    ? timestamp(query.modifiedAfter, "modifiedAfter")
    : undefined;
  let modifiedBefore = query.modifiedBefore
    ? timestamp(query.modifiedBefore, "modifiedBefore")
    : undefined;
  let normalized: DriveSearchQuery = {};
  if (namePrefix) normalized.namePrefix = namePrefix;
  if (fullTextContains) normalized.fullTextContains = fullTextContains;
  if (mimeTypes?.length) normalized.mimeTypes = mimeTypes;
  if (modifiedAfter) normalized.modifiedAfter = modifiedAfter;
  if (modifiedBefore) normalized.modifiedBefore = modifiedBefore;
  if (directParentId) normalized.directParentId = directParentId;
  if (query.order) normalized.order = query.order;

  if (Object.keys(normalized).every(key => key === "order")) {
    throw new Error("Drive search requires at least one filter");
  }
  if (normalized.fullTextContains && normalized.order) {
    throw new Error("Drive full-text search cannot specify an order");
  }
  if (normalized.modifiedAfter && normalized.modifiedBefore &&
      Date.parse(normalized.modifiedAfter) >= Date.parse(normalized.modifiedBefore)) {
    throw new Error("modifiedAfter must be earlier than modifiedBefore");
  }
  return normalized;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function scopePhrase(scope: DriveBindingScope): string {
  switch (scope.kind) {
    case "account": return "the connected Drive account";
    case "folder": return `folder ${scope.folderId}`;
    case "file": return `file ${scope.fileId}`;
  }
}

function queryClauses(query: DriveListFilesOptions): string[] {
  let parts: string[] = [];
  if (query.namePrefix) {
    parts.push(`name starts with "${clip(query.namePrefix, MAX_OBSERVATION_VALUE)}"`);
  }
  if (query.fullTextContains) {
    parts.push(`full text contains "${clip(query.fullTextContains, MAX_OBSERVATION_VALUE)}"`);
  }
  if (query.mimeTypes?.length) {
    parts.push(`mime types ${query.mimeTypes.map(value => clip(value, MAX_OBSERVATION_VALUE)).join(", ")}`);
  }
  if (query.modifiedAfter) parts.push(`modified after ${query.modifiedAfter}`);
  if (query.modifiedBefore) parts.push(`modified before ${query.modifiedBefore}`);
  if (query.directParentIds?.length) {
    let noun = query.directParentIds.length === 1 ? "parent" : "parents";
    parts.push(
      `${noun} ${query.directParentIds.map(id => clip(id, MAX_OBSERVATION_VALUE)).join(", ")}`);
  }
  return parts;
}

function listingDescription(
  scope: DriveBindingScope,
  query: DriveListFilesOptions,
  count: number,
): string {
  let noun = count === 1 ? "entry" : "entries";
  let clauses = queryClauses(query);
  let text = `Read metadata for ${count} Drive ${noun} in ${scopePhrase(scope)}`;
  if (clauses.length) text += `; ${clauses.join("; ")}`;
  return clip(`${text}.`, MAX_OBSERVATION_DESCRIPTION);
}

function emptySearchDescription(scope: DriveBindingScope, query: DriveListFilesOptions): string {
  let text = `Search for Drive metadata in ${scopePhrase(scope)}`;
  let clauses = queryClauses(query);
  if (clauses.length) text += `; ${clauses.join("; ")}`;
  return clip(`${text}.`, MAX_OBSERVATION_DESCRIPTION);
}

/**
 * Drive's indistinguishable "absent or not permitted" answer about one file.
 *
 * One definition, because both cores and the batch path must agree on it: a reason Google
 * documents as account-wide is an outage, not a scope fact, and recording it would narrow a
 * listing or deny a binding for everyone.
 */
function isFileInvisible(error: unknown): boolean {
  return error instanceof DriveApiRequestError && !error.isAccountWide &&
    (error.status === 403 || error.status === 404);
}

/**
 * The disclosure protocol both cores run: observation staging, the withheld fence, and the
 * per-page authorization rule.
 *
 * Shared rather than copied because the fence ordering and the empty-search refusal are
 * security-relevant, and two copies of a security rule drift without saying so.
 */
abstract class DriveCoreBase {
  protected readonly api: DriveSessionApi;
  protected readonly prepareObservation:
    (observations: DriveObservation[]) => Promise<ObserverCheck<DriveObservation>>;
  protected readonly authorize: (description: ObservationDescription) => Promise<void>;
  readonly #prepareWithheld: () => ObserverCheck<DriveObservation>;

  constructor(options: Omit<DriveSessionCoreOptions, "scope">) {
    this.api = options.api;
    this.prepareObservation = options.prepareObservation;
    this.authorize = options.authorize;
    this.#prepareWithheld = options.prepareWithheld;
  }

  /** Stage, authorize, and commit one disclosure of `observations`. */
  protected async authorizeUnits(
    observations: DriveObservation[], title: string, description: string,
  ): Promise<void> {
    let check = await this.prepareObservation(observations);
    await this.authorize({title, description, excludeObservers: check.excludeObservers});
    check.commit();
  }

  /** {@link authorizeUnits} for plain file IDs. */
  protected authorizeFiles(
    fileIds: readonly string[], title: string, description: string,
  ): Promise<void> {
    return this.authorizeUnits(
      fileIds.map(fileId => ({kind: "file", fileId})), title, description);
  }

  /** Authorize a read no observer can be verified against, closing admission for good. */
  protected async authorizeWithheld(title: string, description: string): Promise<void> {
    let check = this.#prepareWithheld();
    try {
      await this.authorize({title, description, excludeObservers: check.excludeObservers});
    } catch (error) {
      // Only a marked refusal proves the overseer recorded nothing. Any other failure leaves the
      // outcome unknown, so the fence latches exactly as a commit would.
      if (isObservationRefused(error)) check.discard?.();
      else check.commit();
      throw error;
    }
    check.commit();
  }

  /** Current metadata for one file, or `undefined` when it is invisible to this account. */
  protected async tryFetchFile(fileId: string): Promise<DriveFile | undefined> {
    try {
      return await this.api.getFile(fileId);
    } catch (error) {
      if (isFileInvisible(error)) return undefined;
      throw error;
    }
  }

  /**
   * The per-page authorization rule: refuse a terminal empty search, otherwise disclose the page.
   *
   * `revalidate` runs first where the scope can move under the cursor, and `baseUnits` are the
   * units every page of that scope also discloses.
   */
  protected pageAuthorizer(
    scope: DriveBindingScope,
    query: DriveListFilesOptions,
    denyEmptySearch: boolean,
    options: {
      revalidate?: () => Promise<unknown>;
      baseUnits?: readonly DriveObservation[];
    } = {},
  ): (entries: DriveEntry[], exhausted: boolean) => Promise<void> {
    let hasDisclosedEntries = false;
    return async (entries, exhausted) => {
      await options.revalidate?.();
      // An empty nonterminal slice means this call's page budget ran out, not that nothing matches.
      if (entries.length === 0 && exhausted && denyEmptySearch && !hasDisclosedEntries) {
        await this.authorizeWithheld(
          "Search Google Drive metadata", emptySearchDescription(scope, query));
        throw new Error("An empty Drive search cannot be shared safely.");
      }
      await this.authorizeUnits(
        [
          ...(options.baseUnits ?? []),
          ...entries.map(entry => ({kind: "file" as const, fileId: entry.id})),
        ],
        "Read Google Drive metadata",
        listingDescription(scope, query, entries.length),
      );
      if (entries.length > 0) hasDisclosedEntries = true;
    };
  }
}

/** Scope enforcement, pagination, mapping, and observation authorization for account/file sessions. */
export class DriveSessionCore extends DriveCoreBase {
  #scope: DriveSessionScope;

  constructor(options: DriveSessionCoreOptions) {
    super(options);
    this.#scope = options.scope;
  }

  async getScope(): Promise<DriveScope> {
    if (this.#scope.kind === "account") return {kind: "account"};
    let file = await this.#fetchFile(this.#scope.fileId);
    if (file.id !== this.#scope.fileId) outsideScope();
    await this.authorizeFiles([file.id], "Read Google Drive scope",
      "Read the current name of the connected Drive file.");
    return {kind: "file", fileId: file.id, name: file.name};
  }

  async list(options: DriveListOptions = {}): Promise<Pager<DriveEntry>> {
    let directParentId = narrowingParentId(options.directParentId);
    if (directParentId) await this.#assertParent(directParentId);
    if (this.#scope.kind === "file") return this.#exactFileCursor();
    return this.#cursor({
      ...(directParentId ? {directParentIds: [directParentId]} : {}),
      orderBy: orderBy(options.order),
    });
  }

  async search(query: DriveSearchQuery): Promise<Pager<DriveEntry>> {
    rejectChildFolders(query);
    if (this.#scope.kind === "file") {
      throw new Error(
        "A single-file Drive binding cannot be searched; use getEntry() to read the bound file.");
    }
    let normalized = normalizeSearch(query);
    if (normalized.directParentId) await this.#assertParent(normalized.directParentId);
    let {directParentId, ...filters} = normalized;
    return this.#cursor({
      ...filters,
      ...(directParentId ? {directParentIds: [directParentId]} : {}),
      orderBy: normalized.fullTextContains ? null : orderBy(normalized.order),
    }, true);
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    await this.authorizeFiles([file.id], "Read Google Drive metadata",
      `Read metadata for Drive file ${file.id}.`);
    return driveFileToEntry(file);
  }

  /** Validate and authorize one native file before a nested content session is created. */
  async openNativeFile(
    fileId: string,
    expectedMimeType: string,
    description: string,
  ): Promise<string> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    await this.authorizeFiles([file.id], `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`);
    if (file.mimeType !== expectedMimeType) {
      throw new Error(`The requested Drive file is not a ${description}.`);
    }
    return file.id;
  }

  /** Native reads need no moving-scope check for immutable account/file capabilities. */
  nativeRead(_fileId: string, _expectedMimeType: string): NativeRead {
    return unguardedNativeRead(this.authorize);
  }

  async #cursor(query: DriveListFilesOptions, denyEmptySearch = false): Promise<Pager<DriveEntry>> {
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        let page = await this.api.listFiles({...query, corpus: {kind: "user"}, pageToken});
        return {items: page.files, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {})};
      },
      buildEntries: async files => files.map(file => driveFileToEntry(file)),
      authorize: this.pageAuthorizer(this.#scope, query, denyEmptySearch),
    });
  }

  #exactFileCursor(): Pager<DriveEntry> {
    let fileId = this.#scope.kind === "file" ? this.#scope.fileId : outsideScope();
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async () => ({items: [await this.api.getFile(fileId)]}),
      buildEntries: async files => {
        if (files.length !== 1 || files[0].id !== fileId) outsideScope();
        return files[0].trashed === false ? [driveFileToEntry(files[0])] : [];
      },
      authorize: async () => this.authorizeFiles([fileId], "Read Google Drive metadata",
        `Read metadata for Drive file ${fileId}.`),
    });
  }

  async #assertParent(parentId: string): Promise<void> {
    if (this.#scope.kind === "file") outsideScope();
    let parent = await this.#fetchFile(parentId);
    if (parent.id !== parentId) outsideScope();
    let title = "Check Google Drive folder";
    let description = "Check that the requested parent folder belongs to this Drive binding.";
    if (!isListableFolderFile(parent)) {
      // On a live folder only `canListChildren` is owner-relative and needs the fence; a
      // non-folder or a trashed one is an objective refusal a listing would disclose anyway.
      if (parent.mimeType === FOLDER_MIME_TYPE && parent.trashed === false) {
        await this.authorizeWithheld(title, description);
      } else {
        await this.authorizeFiles([parent.id], title, description);
      }
      throw new Error("directParentId must identify a folder whose children can be listed");
    }
    // A folder unit, not a file: the disclosure is that this account can list the folder, which a
    // metadata-only observer must fail rather than pass vacuously.
    await this.authorizeUnits([{kind: "folder", fileId: parent.id}], title, description);
  }

  /**
   * Like {@link tryFetchFile}, but an account binding records the invisible answer before
   * rethrowing: with nothing durable recorded, a collaborator admitted later would inherit that
   * disclosure unchecked.
   */
  async #fetchFile(fileId: string): Promise<DriveFile> {
    try {
      return await this.api.getFile(fileId);
    } catch (error) {
      if (this.#scope.kind === "account" && isFileInvisible(error)) {
        await this.authorizeFiles([fileId], "Check Google Drive file access",
          `Check whether the connected account can access Drive file ${fileId}.`);
      }
      throw error;
    }
  }
}

/**
 * The positioned folder is the only parent a folder binding searches, so a caller-supplied one is
 * refused rather than dropped: the provider call overrides it, but it would still reach the
 * observation description and report a folder that was never read.
 */
function rejectDirectParent(query: DriveFolderListOptions | DriveFolderSearchQuery): void {
  if ((query as DriveSearchQuery).directParentId !== undefined) {
    throw new Error("A Drive folder binding is already scoped; directParentId is not accepted.");
  }
}

/** Only a positioned folder has child folders to search, so an account caller is refused here. */
function rejectChildFolders(query: DriveSearchQuery): void {
  if ((query as DriveFolderSearchQuery).childFolderIds !== undefined) {
    throw new Error(
      "Only a Drive folder binding can search child folders; childFolderIds is not accepted.");
  }
}

/** Direct-child Drive access positioned at one provider-validated folder path. */
export class DriveFolderSessionCore extends DriveCoreBase {
  #location: FolderLocation;

  constructor(options: DriveFolderSessionCoreOptions) {
    super(options);
    this.#location = {folderIds: [...options.location.folderIds]};
  }

  async getScope(): Promise<DriveScope> {
    let path = await this.#readLocation();
    let folder = await this.#readCurrentFolder(path);
    await this.#readLocation();
    await this.authorizeUnits([this.#folderObservation()], "Read Google Drive scope",
      "Read the current name of the connected Drive folder.");
    return {
      kind: "folder", folderId: folder.id, rootFolderId: this.#rootId(), name: folder.name,
    };
  }

  async list(options: DriveFolderListOptions = {}): Promise<Pager<DriveEntry>> {
    rejectDirectParent(options);
    return this.#cursor({orderBy: orderBy(options.order)});
  }

  async search(query: DriveFolderSearchQuery): Promise<Pager<DriveEntry>> {
    rejectDirectParent(query);
    let {childFolderIds, ...filters} = query;
    let children = narrowingChildFolderIds(childFolderIds);
    let normalized = normalizeSearch(filters);
    return this.#cursor({
      ...normalized,
      orderBy: normalized.fullTextContains ? null : orderBy(normalized.order),
    }, true, children);
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    let file = await this.#requireDirectFile(fileId);
    await this.authorizeUnits(
      [this.#folderObservation(), {kind: "file", fileId: file.id}],
      "Read Google Drive metadata", `Read metadata for Drive file ${file.id}.`);
    return driveFileToEntry(file);
  }

  /** Validate and authorize one direct native child before its content session is created. */
  async openNativeFile(
    fileId: string,
    expectedMimeType: string,
    description: string,
  ): Promise<string> {
    let file = await this.#requireDirectFile(fileId);
    await this.authorizeUnits(
      [this.#folderObservation(), {kind: "file", fileId: file.id}],
      `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`,
    );
    if (file.mimeType !== expectedMimeType) {
      throw new Error(`The requested Drive file is not a ${description}.`);
    }
    return file.id;
  }

  /**
   * Disclose why a folder cannot stand as a parent here, then refuse.
   *
   * Only `canListChildren` is owner-relative and needs the fence; a non-folder or a trashed one is
   * an objective refusal `list()` would disclose anyway, so it is recorded as a file unit.
   */
  async #refuseUnlistable(node: DriveScopeNode): Promise<never> {
    let title = "Check Google Drive folder";
    let description = "Check whether a requested folder can be opened here.";
    if (node.mimeType === FOLDER_MIME_TYPE) await this.authorizeWithheld(title, description);
    else {
      await this.authorizeUnits(
        [this.#folderObservation(), {kind: "file", fileId: node.id}], title, description);
    }
    outsideScope();
  }

  /** Open one live, listable direct child folder and append its checked path edge. */
  async openFolder(folderId: string): Promise<FolderLocation> {
    let folder = await this.#requireDirectFile(folderId);
    if (!isListableFolderFile(folder)) await this.#refuseUnlistable(folder);
    await this.authorizeUnits(
      [this.#folderObservation(), {kind: "folder", fileId: folder.id}],
      "Open Google Drive folder", `Open direct child folder ${folder.id}.`);
    return {folderIds: [...this.#location.folderIds, folder.id]};
  }

  /** Revalidate the saved path and direct child on every native Docs or Sheets read. */
  nativeRead(fileId: string, expectedMimeType: string): NativeRead {
    return async <T>(fetch: () => Promise<T>, observe: (value: T) => NativeObservation) => {
      let before = await this.#requireDirectFile(fileId);
      if (before.mimeType !== expectedMimeType) outsideScope();
      let value = await fetch();
      let after = await this.#requireDirectFile(fileId);
      if (after.mimeType !== expectedMimeType) outsideScope();
      let check = await this.prepareObservation(
        [this.#folderObservation(), {kind: "file", fileId}]);
      await this.authorize({...observe(value), excludeObservers: check.excludeObservers});
      check.commit();
      return value;
    };
  }

  /**
   * The bound drive is learned from the first page's own revalidation rather than a read taken
   * before the cursor is returned, so calling `list()` and never paging authorizes nothing and
   * discloses nothing about the saved path.
   */
  #cursor(
    query: DriveListFilesOptions,
    denyEmptySearch = false,
    childFolderIds?: readonly string[],
  ): Pager<DriveEntry> {
    let bound: {driveId: string | undefined} | undefined;
    // Revalidated per page: the saved path, plus any named child folders, since one moved out
    // mid-pagination would otherwise keep having its contents disclosed as in scope.
    let readScope = async (): Promise<FolderPageScope> => {
      let path = await this.#readLocation();
      bound ??= {driveId: path[0].driveId};
      if (bound.driveId !== path[0].driveId) throw new Error(FOLDER_MOVED);
      let current = path[path.length - 1];
      return {
        driveId: path[0].driveId,
        parents: childFolderIds
          ? await this.#requireChildFolders(childFolderIds, current)
          : [current],
      };
    };
    // `buildEntries` and the authorizer run back to back with no provider read between them, so
    // they share one post-fetch proof instead of taking the same batches twice.
    let afterFetch: Promise<FolderPageScope> | undefined;
    let sinceFetch = () => (afterFetch ??= readScope());
    let parentIds = childFolderIds ?? [this.#currentFolderId()];
    let audited = childFolderIds ? {...query, directParentIds: childFolderIds} : query;
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        afterFetch = undefined;
        let {driveId} = await readScope();
        let page = await this.api.listFiles({
          ...query,
          directParentIds: parentIds,
          corpus: driveId ? {kind: "drive", driveId} : {kind: "user"},
          pageToken,
        });
        return {items: page.files, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {})};
      },
      buildEntries: async files => {
        let {parents} = await sinceFetch();
        if (files.some(file => !parents.some(parent => isDirectChild(file, parent)))) outsideScope();
        return files.map(file => driveFileToEntry(file));
      },
      authorize: this.pageAuthorizer(
        {kind: "folder", folderId: this.#currentFolderId()}, audited, denyEmptySearch,
        {revalidate: sinceFetch, baseUnits: [
          this.#folderObservation(),
          ...(childFolderIds ?? []).map(id => ({kind: "folder" as const, fileId: id})),
        ]}),
    });
  }

  /**
   * Prove every named folder is a listable direct child of `current`, in one batch.
   *
   * Same predicate and same fence as {@link openFolder}: invisible or live-but-unlistable is
   * owner-relative, while a non-folder, a trashed one, or a non-child is an objective refusal a
   * listing of this folder would disclose anyway.
   */
  async #requireChildFolders(
    folderIds: readonly string[], current: DriveScopeNode,
  ): Promise<DriveScopeNode[]> {
    let nodes = await this.api.getScopeNodes(folderIds);
    for (let node of nodes) {
      if (!node) {
        await this.authorizeWithheld("Check Google Drive folder",
          "Check whether a requested folder is a listable direct child here.");
        outsideScope();
      }
      if (!isDirectChild(node, current)) outsideScope();
      if (!isListableFolderNode(node)) await this.#refuseUnlistable(node);
    }
    return nodes as DriveScopeNode[];
  }

  async #readLocation(): Promise<DriveScopeNode[]> {
    return readFolderLocation(this.#location, ids => this.api.getScopeNodes(ids));
  }

  async #readCurrentFolder(path: DriveScopeNode[]): Promise<DriveFile> {
    let current = path[path.length - 1];
    let folder = await this.tryFetchFile(current.id);
    if (!folder || folder.id !== current.id || !isListableFolderFile(folder) ||
        folder.driveId !== path[0].driveId ||
        (path.length > 1 && !isDirectChild(folder, path[path.length - 2]))) {
      outsideScope();
    }
    return folder;
  }

  async #requireDirectFile(fileId: string): Promise<DriveFile> {
    let path = await this.#readLocation();
    let file = await this.tryFetchFile(fileId);
    if (!file || file.id !== fileId) {
      // Invisible to this account, which is an owner-relative answer: fence it. Whether a visible
      // file is a direct child is objective, so refusing that discloses nothing and stays open.
      await this.authorizeWithheld(
        "Check Google Drive folder",
        "Check whether a requested file is a direct child of this Drive folder.");
      outsideScope();
    }
    if (!isDirectChild(file, path[path.length - 1])) outsideScope();
    await this.#readLocation();
    return file;
  }

  #rootId(): string {
    return this.#location.folderIds[0];
  }

  #currentFolderId(): string {
    return this.#location.folderIds[this.#location.folderIds.length - 1];
  }

  #folderObservation(): DriveObservation {
    return {kind: "folder", fileId: this.#currentFolderId()};
  }
}
