import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CursorPager, type Pager } from "./cursor";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE,
  type DriveApi, type DriveFile, type DriveListFilesOptions, type DriveScopeNode,
} from "./drive-api";
import {
  isDirectChild, outsideScope, readFolderLocation,
  type FolderLocation,
} from "./drive-folder-scope";
import type { DriveObservation } from "./drive-observers";
import type { ObserverCheck } from "./observers";
import type {
  DriveEntry, DriveListOptions, DriveOrder, DriveScope, DriveSearchQuery,
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

/**
 * Maps one validated provider file to the permanent agent-facing declaration.
 *
 * `rootId` names a scope root whose own `parentId` is withheld: the folder containing the bound
 * folder is outside the binding, and naming it would disclose one level above it.
 */
export function driveFileToEntry(file: DriveFile, rootId?: string): DriveEntry {
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
  let parentId = file.id === rootId ? undefined : file.parents?.[0];
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
    ...(parentId ? { parentId } : {}),
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

function normalizeSearch(query: DriveSearchQuery): DriveSearchQuery {
  let namePrefix = query.namePrefix?.trim();
  let fullTextContains = query.fullTextContains?.trim();
  let directParentId = query.directParentId?.trim();
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
  if (query.directParentId) {
    parts.push(`parent ${clip(query.directParentId, MAX_OBSERVATION_VALUE)}`);
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

/** Scope enforcement, pagination, mapping, and observation authorization for account/file sessions. */
export class DriveSessionCore {
  #api: DriveSessionApi;
  #scope: DriveSessionScope;
  #prepareObservation: (observations: DriveObservation[]) => Promise<ObserverCheck<DriveObservation>>;
  #prepareWithheld: () => ObserverCheck<DriveObservation>;
  #authorize: (description: ObservationDescription) => Promise<void>;

  constructor(options: DriveSessionCoreOptions) {
    this.#api = options.api;
    this.#scope = options.scope;
    this.#prepareObservation = options.prepareObservation;
    this.#prepareWithheld = options.prepareWithheld;
    this.#authorize = options.authorize;
  }

  async getScope(): Promise<DriveScope> {
    if (this.#scope.kind === "account") return {kind: "account"};
    let file = await this.#fetchFile(this.#scope.fileId);
    if (file.id !== this.#scope.fileId) outsideScope();
    await this.#authorizeFiles([file.id], "Read Google Drive scope",
      "Read the current name of the connected Drive file.");
    return {kind: "file", fileId: file.id, name: file.name};
  }

  async list(options: DriveListOptions = {}): Promise<Pager<DriveEntry>> {
    let directParentId = options.directParentId?.trim();
    if (directParentId) await this.#assertParent(directParentId);
    if (this.#scope.kind === "file") return this.#exactFileCursor();
    return this.#cursor({
      ...(directParentId ? {directParentId} : {}),
      orderBy: orderBy(options.order),
    });
  }

  async search(query: DriveSearchQuery): Promise<Pager<DriveEntry>> {
    if (this.#scope.kind === "file") {
      throw new Error(
        "A single-file Drive binding cannot be searched; use getEntry() to read the bound file.");
    }
    let normalized = normalizeSearch(query);
    if (normalized.directParentId) await this.#assertParent(normalized.directParentId);
    return this.#cursor({
      ...normalized,
      orderBy: normalized.fullTextContains ? null : orderBy(normalized.order),
    }, true);
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    await this.#authorizeFiles([file.id], "Read Google Drive metadata",
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
    await this.#authorizeFiles([file.id], `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`);
    if (file.mimeType !== expectedMimeType) {
      throw new Error(`The requested Drive file is not a ${description}.`);
    }
    return file.id;
  }

  /** Native reads need no moving-scope check for immutable account/file capabilities. */
  nativeRead(_fileId: string, _expectedMimeType: string): NativeRead {
    return unguardedNativeRead(description => this.#authorize(description));
  }

  async #cursor(query: DriveListFilesOptions, denyEmptySearch = false): Promise<Pager<DriveEntry>> {
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        let page = await this.#api.listFiles({...query, corpus: {kind: "user"}, pageToken});
        return {items: page.files, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {})};
      },
      buildEntries: async files => files.map(file => driveFileToEntry(file)),
      authorize: this.#pageAuthorizer(query, denyEmptySearch),
    });
  }

  #exactFileCursor(): Pager<DriveEntry> {
    let fileId = this.#scope.kind === "file" ? this.#scope.fileId : outsideScope();
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async () => ({items: [await this.#api.getFile(fileId)]}),
      buildEntries: async files => {
        if (files.length !== 1 || files[0].id !== fileId) outsideScope();
        return files[0].trashed === false ? [driveFileToEntry(files[0])] : [];
      },
      authorize: async () => this.#authorizeFiles([fileId], "Read Google Drive metadata",
        `Read metadata for Drive file ${fileId}.`),
    });
  }

  #pageAuthorizer(
    query: DriveListFilesOptions,
    denyEmptySearch: boolean,
  ): (entries: DriveEntry[], exhausted: boolean) => Promise<void> {
    let hasDisclosedEntries = false;
    return async (entries, exhausted) => {
      // An empty nonterminal slice means this call's page budget ran out, not that nothing matches.
      if (entries.length === 0 && exhausted && denyEmptySearch && !hasDisclosedEntries) {
        await this.#authorizeWithheld(
          "Search Google Drive metadata", emptySearchDescription(this.#scope, query));
        throw new Error("An empty Drive search cannot be shared safely.");
      }
      await this.#authorizeFiles(entries.map(entry => entry.id), "Read Google Drive metadata",
        listingDescription(this.#scope, query, entries.length));
      if (entries.length > 0) hasDisclosedEntries = true;
    };
  }

  async #assertParent(parentId: string): Promise<void> {
    if (this.#scope.kind === "file") outsideScope();
    let parent = await this.#fetchFile(parentId);
    if (parent.id !== parentId) outsideScope();
    await this.#authorizeFiles([parent.id], "Check Google Drive folder",
      "Check that the requested parent folder belongs to this Drive binding.");
    if (parent.mimeType !== FOLDER_MIME_TYPE || parent.capabilities?.canListChildren !== true) {
      throw new Error("directParentId must identify a folder whose children can be listed");
    }
  }

  async #fetchFile(fileId: string): Promise<DriveFile> {
    try {
      return await this.#api.getFile(fileId);
    } catch (error) {
      if (this.#scope.kind === "account" && error instanceof DriveApiRequestError &&
          !error.isAccountWide && (error.status === 403 || error.status === 404)) {
        await this.#authorizeFiles([fileId], "Check Google Drive file access",
          `Check whether the connected account can access Drive file ${fileId}.`);
      }
      throw error;
    }
  }

  async #authorizeFiles(fileIds: string[], title: string, description: string): Promise<void> {
    let observations: DriveObservation[] = fileIds.map(fileId => ({kind: "file", fileId}));
    let check = await this.#prepareObservation(observations);
    await this.#authorize({title, description, excludeObservers: check.excludeObservers});
    check.commit();
  }

  async #authorizeWithheld(title: string, description: string): Promise<void> {
    let check = this.#prepareWithheld();
    try {
      await this.#authorize({title, description, excludeObservers: check.excludeObservers});
    } catch (error) {
      check.discard?.();
      throw error;
    }
    check.commit();
  }
}

/** Direct-child Drive access positioned at one provider-validated folder path. */
export class DriveFolderSessionCore {
  #api: DriveSessionApi;
  #location: FolderLocation;
  #prepareObservation: (observations: DriveObservation[]) => Promise<ObserverCheck<DriveObservation>>;
  #prepareWithheld: () => ObserverCheck<DriveObservation>;
  #authorize: (description: ObservationDescription) => Promise<void>;

  constructor(options: DriveFolderSessionCoreOptions) {
    this.#api = options.api;
    this.#location = {rootId: options.location.rootId, folderIds: [...options.location.folderIds]};
    this.#prepareObservation = options.prepareObservation;
    this.#prepareWithheld = options.prepareWithheld;
    this.#authorize = options.authorize;
  }

  async getScope(): Promise<DriveScope> {
    let path = await this.#readLocation();
    let folder = await this.#readCurrentFolder(path);
    await this.#readLocation();
    await this.#authorizeUnits([this.#folderObservation()], "Read Google Drive scope",
      "Read the current name of the connected Drive folder.");
    return {
      kind: "folder", folderId: folder.id, rootFolderId: this.#location.rootId, name: folder.name,
    };
  }

  async list(options: DriveListOptions = {}): Promise<Pager<DriveEntry>> {
    return this.#cursor({orderBy: orderBy(options.order)});
  }

  async search(query: DriveSearchQuery): Promise<Pager<DriveEntry>> {
    let normalized = normalizeSearch(query);
    return this.#cursor({
      ...normalized,
      orderBy: normalized.fullTextContains ? null : orderBy(normalized.order),
    }, true);
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    let file = await this.#requireDirectFile(fileId);
    let entry = driveFileToEntry(file);
    await this.#authorizeUnits(
      [this.#folderObservation(), {kind: "file", fileId: file.id}],
      "Read Google Drive metadata", `Read metadata for Drive file ${file.id}.`);
    return entry;
  }

  /** Validate and authorize one direct native child before its content session is created. */
  async openNativeFile(
    fileId: string,
    expectedMimeType: string,
    description: string,
  ): Promise<string> {
    let file = await this.#requireDirectFile(fileId);
    await this.#authorizeUnits(
      [this.#folderObservation(), {kind: "file", fileId: file.id}],
      `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`,
    );
    if (file.mimeType !== expectedMimeType) {
      throw new Error(`The requested Drive file is not a ${description}.`);
    }
    return file.id;
  }

  /** Open one live, listable direct child folder and append its checked path edge. */
  async openFolder(folderId: string): Promise<FolderLocation> {
    let folder = await this.#requireDirectFile(folderId);
    if (folder.mimeType !== FOLDER_MIME_TYPE || folder.capabilities?.canListChildren !== true) {
      await this.#authorizeWithheld(
        "Check Google Drive folder", "Check whether a requested folder can be opened here.");
      outsideScope();
    }
    await this.#authorizeUnits(
      [this.#folderObservation(), {kind: "folder", fileId: folder.id}],
      "Open Google Drive folder", `Open direct child folder ${folder.id}.`);
    return {
      rootId: this.#location.rootId,
      folderIds: [...this.#location.folderIds, folder.id],
    };
  }

  /** Revalidate the saved path and direct child on every native Docs or Sheets read. */
  nativeRead(fileId: string, expectedMimeType: string): NativeRead {
    return async <T>(fetch: () => Promise<T>, observe: (value: T) => NativeObservation) => {
      let before = await this.#requireDirectFile(fileId);
      if (before.mimeType !== expectedMimeType) outsideScope();
      let value = await fetch();
      let after = await this.#requireDirectFile(fileId);
      if (after.mimeType !== expectedMimeType) outsideScope();
      let check = await this.#prepareObservation(
        [this.#folderObservation(), {kind: "file", fileId}]);
      await this.#authorize({...observe(value), excludeObservers: check.excludeObservers});
      check.commit();
      return value;
    };
  }

  async #cursor(query: DriveListFilesOptions, denyEmptySearch = false): Promise<Pager<DriveEntry>> {
    let initial = await this.#readLocation();
    let driveId = initial[0].driveId;
    let corpus = driveId ? {kind: "drive" as const, driveId} : {kind: "user" as const};
    let requireCurrentLocation = async () => {
      let path = await this.#readLocation();
      if (path[0].driveId !== driveId) throw new Error(FOLDER_MOVED);
      return path;
    };
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        await requireCurrentLocation();
        let page = await this.#api.listFiles({
          ...query, directParentId: this.#currentFolderId(), corpus, pageToken,
        });
        return {items: page.files, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {})};
      },
      buildEntries: async files => {
        let path = await requireCurrentLocation();
        let parent = path[path.length - 1];
        if (files.some(file => !isDirectChild(file, parent))) outsideScope();
        return files.map(file => driveFileToEntry(file));
      },
      authorize: this.#pageAuthorizer(query, denyEmptySearch, requireCurrentLocation),
    });
  }

  #pageAuthorizer(
    query: DriveListFilesOptions,
    denyEmptySearch: boolean,
    revalidate: () => Promise<DriveScopeNode[]>,
  ): (entries: DriveEntry[], exhausted: boolean) => Promise<void> {
    let hasDisclosedEntries = false;
    let scope: DriveBindingScope = {kind: "folder", folderId: this.#currentFolderId()};
    return async (entries, exhausted) => {
      await revalidate();
      // An empty nonterminal slice means this call's page budget ran out, not that nothing matches.
      if (entries.length === 0 && exhausted && denyEmptySearch && !hasDisclosedEntries) {
        await this.#authorizeWithheld(
          "Search Google Drive metadata", emptySearchDescription(scope, query));
        throw new Error("An empty Drive search cannot be shared safely.");
      }
      let observations: DriveObservation[] = [
        this.#folderObservation(),
        ...entries.map(entry => ({kind: "file" as const, fileId: entry.id})),
      ];
      await this.#authorizeUnits(observations, "Read Google Drive metadata",
        listingDescription(scope, query, entries.length));
      if (entries.length > 0) hasDisclosedEntries = true;
    };
  }

  async #readLocation(): Promise<DriveScopeNode[]> {
    return readFolderLocation(this.#location, ids => this.#api.getScopeNodes(ids));
  }

  async #readCurrentFolder(path: DriveScopeNode[]): Promise<DriveFile> {
    let current = path[path.length - 1];
    let folder = await this.#tryFetchFile(current.id);
    if (!folder || folder.id !== current.id || folder.mimeType !== FOLDER_MIME_TYPE ||
        folder.capabilities?.canListChildren !== true || folder.trashed !== false ||
        folder.driveId !== path[0].driveId ||
        (path.length > 1 && !isDirectChild(folder, path[path.length - 2]))) {
      outsideScope();
    }
    return folder;
  }

  async #requireDirectFile(fileId: string): Promise<DriveFile> {
    let path = await this.#readLocation();
    let file = await this.#tryFetchFile(fileId);
    if (!file || file.id !== fileId || !isDirectChild(file, path[path.length - 1])) {
      await this.#authorizeWithheld(
        "Check Google Drive folder",
        "Check whether a requested file is a direct child of this Drive folder.");
      outsideScope();
    }
    await this.#readLocation();
    return file;
  }

  async #tryFetchFile(fileId: string): Promise<DriveFile | undefined> {
    try {
      return await this.#api.getFile(fileId);
    } catch (error) {
      if (error instanceof DriveApiRequestError && !error.isAccountWide &&
          (error.status === 403 || error.status === 404)) {
        return undefined;
      }
      throw error;
    }
  }

  #currentFolderId(): string {
    return this.#location.folderIds[this.#location.folderIds.length - 1];
  }

  #folderObservation(): DriveObservation {
    return {kind: "folder", fileId: this.#currentFolderId()};
  }

  async #authorizeUnits(
    observations: DriveObservation[], title: string, description: string,
  ): Promise<void> {
    let check = await this.#prepareObservation(observations);
    await this.#authorize({title, description, excludeObservers: check.excludeObservers});
    check.commit();
  }

  async #authorizeWithheld(title: string, description: string): Promise<void> {
    let check = this.#prepareWithheld();
    try {
      await this.#authorize({title, description, excludeObservers: check.excludeObservers});
    } catch (error) {
      check.discard?.();
      throw error;
    }
    check.commit();
  }
}
