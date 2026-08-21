import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CursorPager, type Pager } from "./cursor";
import { DriveApiRequestError, type DriveApi, type DriveCorpus, type DriveFile, type DriveListFilesOptions } from "./drive-api";
import type { ObserverCheck } from "./observers";
import type {
  DriveEntry, DriveListOptions, DriveOrder, DriveScope, DriveSearchQuery,
} from "./drive-types";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
/** Exact MIME type for native Google Docs files. */
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
/** Exact MIME type for native Google Sheets files. */
export const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

// Agent-supplied query values go in the approval description, so each value and the whole string
// are capped. They are not logged and they stay out of the title.
const MAX_OBSERVATION_VALUE = 32;
const MAX_OBSERVATION_DESCRIPTION = 240;

/** Immutable authority carried by one Drive gatekeeper binding. */
export type DriveBindingScope =
  | { kind: "account" }
  | { kind: "sharedDrive"; driveId: string }
  | { kind: "file"; fileId: string };

type DriveSessionApi = Pick<DriveApi, "listFiles" | "getFile" | "getDrive">;

/**
 * Everything one Drive session core enforces and reports through.
 *
 * `authorize` is part of the construction because it is the one thing that differs between the
 * cores a session builds: they share its scope and observer tracking, but a capability handed to
 * the caller -- a cursor -- authorizes through an approval queue with its own lifetime.
 */
export type DriveSessionCoreOptions = {
  api: DriveSessionApi;
  scope: DriveBindingScope;
  prepareObservation(fileIds: string[]): Promise<ObserverCheck<string>>;
  observerIds(): string[];
  authorize(description: ObservationDescription): Promise<void>;
};

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Google Drive omitted required file ${field}`);
  return value;
}

/** Maps one validated provider file to the permanent agent-facing declaration. */
export function driveFileToEntry(file: DriveFile): DriveEntry {
  let mimeType = requiredString(file.mimeType, "mimeType");
  let isFolder = mimeType === FOLDER_MIME_TYPE;
  let isShortcut = mimeType === SHORTCUT_MIME_TYPE;
  let modifiedTime = new Date(requiredString(file.modifiedTime, "modifiedTime"));
  if (Number.isNaN(modifiedTime.valueOf())) throw new Error("Google Drive returned an invalid modifiedTime");

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
    case "sharedDrive": return `shared drive ${scope.driveId}`;
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

/** Scope enforcement, pagination, mapping, and observation authorization for Drive sessions. */
export class DriveSessionCore {
  #api: DriveSessionApi;
  #scope: DriveBindingScope;
  #prepareObservation: (fileIds: string[]) => Promise<ObserverCheck<string>>;
  #observerIds: () => string[];
  #authorize: (description: ObservationDescription) => Promise<void>;

  constructor(options: DriveSessionCoreOptions) {
    this.#api = options.api;
    this.#scope = options.scope;
    this.#prepareObservation = options.prepareObservation;
    this.#observerIds = options.observerIds;
    this.#authorize = options.authorize;
  }

  async getScope(): Promise<DriveScope> {
    switch (this.#scope.kind) {
      case "account": return { kind: "account" };
      case "sharedDrive": {
        let drive = await this.#api.getDrive(this.#scope.driveId);
        // Capability identity is the binding, never the provider's echo. A mismatch means the name
        // describes some other drive, so refuse rather than label the binding with it.
        if (drive.id !== this.#scope.driveId) this.#outsideScope();
        await this.#authorizeIds([this.#scope.driveId], "Read Google Drive scope",
          "Read the current name of the connected shared drive.");
        return { kind: "sharedDrive", driveId: this.#scope.driveId, name: drive.name };
      }
      case "file": {
        let file = await this.#api.getFile(this.#scope.fileId);
        if (file.id !== this.#scope.fileId) this.#outsideScope();
        await this.#authorizeIds([this.#scope.fileId], "Read Google Drive scope",
          "Read the current name of the connected Drive file.");
        return { kind: "file", fileId: this.#scope.fileId, name: file.name };
      }
    }
  }

  async list(options: DriveListOptions = {}): Promise<Pager<DriveEntry>> {
    if (options.directParentId) await this.#assertParent(options.directParentId);
    if (this.#scope.kind === "file") return this.#exactFileCursor();
    return this.#cursor({
      ...(options.directParentId ? { directParentId: options.directParentId } : {}),
      orderBy: orderBy(options.order),
    });
  }

  async search(query: DriveSearchQuery): Promise<Pager<DriveEntry>> {
    // Drive `q` has no `id =` clause, and returning the bound file unconditionally would claim it
    // matched filters we never evaluated. list() already short-circuits to getFile; search cannot.
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
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) this.#outsideScope();
    let file = await this.#getFileInScope(fileId);
    let entry = driveFileToEntry(file);
    await this.#authorizeIds([file.id], "Read Google Drive metadata",
      `Read metadata for Drive file ${file.id}.`);
    return entry;
  }

  /** Validate and authorize one native file before a nested content session is created. */
  async openNativeFile(
    fileId: string,
    expectedMimeType: string,
    description: string,
  ): Promise<string> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) this.#outsideScope();
    let file = await this.#getFileInScope(fileId);
    await this.#authorizeIds(
      [file.id],
      `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`,
    );
    if (file.mimeType !== expectedMimeType) {
      throw new Error(`The requested Drive file is not a ${description}.`);
    }
    return file.id;
  }

  #cursor(query: DriveListFilesOptions, denyEmptySearch = false): Pager<DriveEntry> {
    let hasDisclosedEntries = false;
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        let page = await this.#api.listFiles({ ...query, corpus: this.#corpus(), pageToken });
        return { items: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
      },
      buildEntries: async files => files.filter(file => this.#inScope(file)).map(driveFileToEntry),
      authorize: async entries => {
        if (denyEmptySearch && entries.length === 0 && !hasDisclosedEntries) {
          await this.#authorize({
            title: "Search Google Drive metadata",
            description: emptySearchDescription(this.#scope, query),
            excludeObservers: this.#observerIds(),
          });
          throw new Error("An empty Drive search cannot be shared safely.");
        }
        await this.#authorizeIds(
          entries.map(entry => entry.id),
          "Read Google Drive metadata",
          listingDescription(this.#scope, query, entries.length),
        );
        if (entries.length > 0) hasDisclosedEntries = true;
      },
    });
  }

  #exactFileCursor(): Pager<DriveEntry> {
    let fileId = this.#scope.kind === "file" ? this.#scope.fileId : this.#outsideScope();
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async () => ({ items: [await this.#api.getFile(fileId)] }),
      buildEntries: async files => {
        if (files.length !== 1 || files[0].id !== fileId) this.#outsideScope();
        return files[0].trashed === false ? [driveFileToEntry(files[0])] : [];
      },
      authorize: async () => {
        await this.#authorizeIds([fileId], "Read Google Drive metadata",
          `Read metadata for Drive file ${fileId}.`);
      },
    });
  }

  #corpus(): DriveCorpus {
    return this.#scope.kind === "sharedDrive"
      ? { kind: "drive", driveId: this.#scope.driveId }
      : { kind: "user" };
  }

  #inScope(file: DriveFile): boolean {
    switch (this.#scope.kind) {
      case "account": return true;
      case "sharedDrive":
        return file.driveId === this.#scope.driveId || file.id === this.#scope.driveId;
      case "file": return file.id === this.#scope.fileId;
    }
  }

  async #assertParent(parentId: string): Promise<void> {
    if (this.#scope.kind === "file") this.#outsideScope();
    let parent = await this.#getFileInScope(parentId);
    await this.#authorizeIds([parent.id], "Check Google Drive folder",
      "Check that the requested parent folder belongs to this Drive binding.");
    if (parent.mimeType !== FOLDER_MIME_TYPE) throw new Error("directParentId must identify a folder");
  }

  async #getFileInScope(fileId: string): Promise<DriveFile> {
    let file: DriveFile;
    try {
      file = await this.#api.getFile(fileId);
    } catch (err) {
      if (err instanceof DriveApiRequestError && !err.isQuotaExceeded &&
          (err.status === 403 || err.status === 404)) {
        if (this.#scope.kind === "sharedDrive") this.#outsideScope();
        if (this.#scope.kind === "account") {
          // Tracked like a successful read rather than merely hidden from today's observers. An
          // ObservationDescription's exclusion binds only the observers named in it — there is no
          // per-thread hiding — so with none registered the result would be disclosed with nothing
          // durable recorded, and a collaborator admitted later would inherit the history unchecked.
          // Committing the id makes every future addObserver() verify it, and a file this account
          // cannot reach is one no observer can reach either, so that admission fails closed.
          await this.#authorizeIds([fileId], "Check Google Drive file access",
            `Check whether the connected account can access Drive file ${fileId}.`);
        }
      }
      throw err;
    }
    if (file.id !== fileId || !this.#inScope(file)) this.#outsideScope();
    return file;
  }

  async #authorizeIds(fileIds: string[], title: string, description: string): Promise<void> {
    let check = await this.#prepareObservation(fileIds);
    await this.#authorize({ title, description, excludeObservers: check.excludeObservers });
    check.commit();
  }

  #outsideScope(): never {
    throw new Error("The requested file is outside this Drive binding.");
  }
}

