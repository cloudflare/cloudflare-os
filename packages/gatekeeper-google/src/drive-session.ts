import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CursorPager, type Pager } from "./cursor";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE,
  type DriveApi, type DriveCorpus, type DriveFile, type DriveListFilesOptions,
} from "./drive-api";
import { FolderScope, outsideScope, readFolderRoot, type FolderProof } from "./drive-folder-scope";
import type { ObserverCheck } from "./observers";
import type {
  DriveEntry, DriveListOptions, DriveOrder, DriveScope, DriveSearchQuery,
} from "./drive-types";

const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
/** Exact MIME type for native Google Docs files. */
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
/** Exact MIME type for native Google Sheets files. */
export const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

/**
 * Drive items one folder-scoped provider page asks for.
 *
 * Membership is a post-filter -- Drive cannot restrict a listing to a subtree -- so a bare `list()`
 * scans the corpus and a small folder in a large drive costs one round trip per page. Full pages
 * keep that count down; the page budget below still caps a call at one of them. Measured worst
 * case, 100 candidates each 99 levels deep on distinct chains: 203 subrequests for one `next()`.
 */
const FOLDER_PAGE_SIZE = 100;

const FOLDER_MOVED = "The connected Drive folder moved to another drive; open a new listing.";

// Agent-supplied query values go in the approval description, so each value and the whole string
// are capped. They are not logged and they stay out of the title.
const MAX_OBSERVATION_VALUE = 32;
const MAX_OBSERVATION_DESCRIPTION = 240;

/** Immutable authority carried by one Drive gatekeeper binding. */
export type DriveBindingScope =
  | { kind: "account" }
  | { kind: "sharedDrive"; driveId: string }
  | { kind: "folder"; folderId: string }
  | { kind: "file"; fileId: string };

type DriveSessionApi = Pick<DriveApi, "listFiles" | "getFile" | "getDrive" | "getScopeNodes">;

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
  scope: DriveBindingScope;
  prepareObservation(fileIds: string[]): Promise<ObserverCheck<string>>;
  /** Fences an owner-only observation: excludes today's observers and closes admission. */
  prepareWithheld(): ObserverCheck<string>;
  authorize(description: ObservationDescription): Promise<void>;
};

function requiredString(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Google Drive omitted required file ${field}`);
  return value;
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
    case "sharedDrive": return `shared drive ${scope.driveId}`;
    case "folder": return `folder ${scope.folderId} and its descendants`;
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
  #folder: FolderScope;
  #prepareObservation: (fileIds: string[]) => Promise<ObserverCheck<string>>;
  #prepareWithheld: () => ObserverCheck<string>;
  #authorize: (description: ObservationDescription) => Promise<void>;

  constructor(options: DriveSessionCoreOptions) {
    this.#api = options.api;
    this.#scope = options.scope;
    this.#folder = new FolderScope(options.api);
    this.#prepareObservation = options.prepareObservation;
    this.#prepareWithheld = options.prepareWithheld;
    this.#authorize = options.authorize;
  }

  async getScope(): Promise<DriveScope> {
    switch (this.#scope.kind) {
      case "account": return { kind: "account" };
      case "sharedDrive": {
        let drive = await this.#api.getDrive(this.#scope.driveId);
        // Capability identity is the binding, never the provider's echo. A mismatch means the name
        // describes some other drive, so refuse rather than label the binding with it.
        if (drive.id !== this.#scope.driveId) outsideScope();
        await this.#authorizeIds([this.#scope.driveId], "Read Google Drive scope",
          "Read the current name of the connected shared drive.");
        return { kind: "sharedDrive", driveId: this.#scope.driveId, name: drive.name };
      }
      case "folder": {
        let root = await this.#getFolderRoot();
        await this.#authorizeIds([root.id], "Read Google Drive scope",
          "Read the current name of the connected Drive folder.");
        return { kind: "folder", folderId: root.id, name: root.name };
      }
      case "file": {
        let file = await this.#api.getFile(this.#scope.fileId);
        if (file.id !== this.#scope.fileId) outsideScope();
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
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#getFileInScope(fileId);
    let entry = driveFileToEntry(file, this.#rootId());
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
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
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

  /**
   * Wraps one native Docs or Sheets read in the enforcement its binding needs.
   *
   * A folder binding's authority is derived from a hierarchy the provider can change under it, so
   * every read re-proves the file's ancestry and exact native type before the provider is contacted,
   * re-checks the proved chain before the result is authorized, and discards the fetched value if
   * either fails. Drive offers no ancestry-plus-content transaction, so a move landing after that
   * final check still returns; the next read is what denies. Immutable scopes need none of this:
   * the ID they name cannot leave them.
   */
  nativeRead(fileId: string, expectedMimeType: string): NativeRead {
    if (this.#scope.kind !== "folder") {
      return unguardedNativeRead(description => this.#authorize(description));
    }
    return async <T>(fetch: () => Promise<T>, observe: (value: T) => NativeObservation) => {
      let proof = await this.#proveNativeFile(fileId, expectedMimeType);
      let value = await fetch();
      await this.#folder.recheck([proof]);
      let check = await this.#prepareObservation([fileId]);
      await this.#authorize({ ...observe(value), excludeObservers: check.excludeObservers });
      check.commit();
      return value;
    };
  }

  async #cursor(query: DriveListFilesOptions, denyEmptySearch = false): Promise<Pager<DriveEntry>> {
    if (this.#scope.kind === "folder") return this.#folderCursor(query, denyEmptySearch);
    let corpus: DriveCorpus = this.#scope.kind === "sharedDrive"
      ? { kind: "drive", driveId: this.#scope.driveId }
      : { kind: "user" };
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        let page = await this.#api.listFiles({ ...query, corpus, pageToken });
        return { items: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
      },
      buildEntries: async files =>
        files.filter(file => this.#inScope(file)).map(file => driveFileToEntry(file)),
      authorize: this.#pageAuthorizer(query, denyEmptySearch),
    });
  }

  /**
   * A cursor over one folder subtree, on the corpus the root lives in.
   *
   * The corpus is pinned when the cursor opens, because a Drive page token is only valid against
   * the corpus that produced it: a root that moves between My Drive and a shared drive aborts the
   * cursor rather than replaying its token against the other corpus. Every provider page is proved
   * before anything derived from it -- entries, descriptions, observer exclusions -- exists.
   *
   * Bare listings scan the corpus and post-filter, so cost is linear in its size. A BFS from the
   * root over `'<id>' in parents` would fetch only in-scope rows, but it trades `DriveOrder`'s
   * global ordering for per-level ordering and `fullTextContains` cannot use it, so it is a
   * separate change rather than a tweak here.
   */
  async #folderCursor(
    query: DriveListFilesOptions,
    denyEmptySearch: boolean,
  ): Promise<Pager<DriveEntry>> {
    let root = await this.#getFolderRoot();
    let driveId = root.driveId;
    let corpus: DriveCorpus = driveId ? { kind: "drive", driveId } : { kind: "user" };
    // A page token is only valid against the corpus that produced it, and a root that changed drive
    // is still a valid root, so the pin is what catches the move rather than the root check.
    let requirePinnedCorpus = async () => {
      root = await this.#getFolderRoot();
      if (root.driveId !== driveId) throw new Error(FOLDER_MOVED);
    };
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        await requirePinnedCorpus();
        let page = await this.#api.listFiles({
          ...query, corpus, pageSize: FOLDER_PAGE_SIZE, pageToken,
        });
        return { items: page.files, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
      },
      buildEntries: async files => {
        let proofs = await this.#folder.prove(files, root);
        await this.#folder.recheck(proofs);
        // The root bounds the listing rather than appearing in it. `prove` admits it so `getEntry`
        // can read the bound folder's own metadata, but `'<root>' in parents` never returns it, so
        // leaving it here makes a bare listing disclose one entry a narrowed one cannot.
        return proofs.filter(proof => proof.file.id !== root.id)
          .map(proof => driveFileToEntry(proof.file, root.id));
      },
      authorize: this.#pageAuthorizer(query, denyEmptySearch, requirePinnedCorpus),
      // A maximum-depth page costs one ancestry batch per level, so one provider page per call is
      // what keeps a single invocation inside the Worker subrequest ceiling. The cursor contract
      // already requires draining to `null` rather than stopping at an empty page.
      maxProviderPagesPerCall: 1,
    });
  }

  #exactFileCursor(): Pager<DriveEntry> {
    let fileId = this.#scope.kind === "file" ? this.#scope.fileId : outsideScope();
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async () => ({ items: [await this.#api.getFile(fileId)] }),
      buildEntries: async files => {
        if (files.length !== 1 || files[0].id !== fileId) outsideScope();
        return files[0].trashed === false ? [driveFileToEntry(files[0])] : [];
      },
      authorize: async () => {
        await this.#authorizeIds([fileId], "Read Google Drive metadata",
          `Read metadata for Drive file ${fileId}.`);
      },
    });
  }

  #pageAuthorizer(
    query: DriveListFilesOptions,
    denyEmptySearch: boolean,
    revalidate?: () => Promise<void>,
  ): (entries: DriveEntry[], exhausted: boolean) => Promise<void> {
    let hasDisclosedEntries = false;
    return async (entries, exhausted) => {
      // Only an exhausted cursor has actually searched. An intermediate empty page still has
      // results ahead of it, so auditing it as a negative answer -- and fencing on it -- would be
      // a claim about data nobody looked at yet.
      if (denyEmptySearch && exhausted && entries.length === 0 && !hasDisclosedEntries) {
        // The latch is permanent, so confirm the emptiness is not an artifact of the scope having
        // changed under the scan.
        await revalidate?.();
        await this.#refuseEmptySearch(query);
      }
      // A fully-filtered nonterminal page discloses nothing and tracks nothing. Auditing it would
      // bury one real listing under a record per page the scan walked past.
      if (entries.length === 0 && !exhausted) return;
      await this.#authorizeIds(
        entries.map(entry => entry.id),
        "Read Google Drive metadata",
        listingDescription(this.#scope, query, entries.length),
      );
      if (entries.length > 0) hasDisclosedEntries = true;
    };
  }

  /** Audits an owner-only empty search, closes observer admission, and refuses to share it. */
  async #refuseEmptySearch(query: DriveListFilesOptions): Promise<never> {
    let check = this.#prepareWithheld();
    try {
      await this.#authorize({
        title: "Search Google Drive metadata",
        description: emptySearchDescription(this.#scope, query),
        excludeObservers: check.excludeObservers,
      });
    } catch (error) {
      check.discard?.();
      throw error;
    }
    check.commit();
    throw new Error("An empty Drive search cannot be shared safely.");
  }

  #rootId(): string | undefined {
    return this.#scope.kind === "folder" ? this.#scope.folderId : undefined;
  }

  #inScope(file: DriveFile): boolean {
    switch (this.#scope.kind) {
      case "account": return true;
      case "sharedDrive":
        return file.driveId === this.#scope.driveId || file.id === this.#scope.driveId;
      // Membership is a live ancestry proof, not a field comparison, so a folder binding never
      // reaches here.
      case "folder": return false;
      case "file": return file.id === this.#scope.fileId;
    }
  }

  /** The bound folder, re-read and re-validated. Every folder operation starts from this. */
  async #getFolderRoot(): Promise<DriveFile> {
    if (this.#scope.kind !== "folder") outsideScope();
    return readFolderRoot(this.#scope.folderId, id => this.#fetchFile(id));
  }

  /** One candidate's live membership proof. A direct read admits exactly one result. */
  async #proveFile(file: DriveFile, root: DriveFile): Promise<FolderProof> {
    let [proof] = await this.#folder.prove([file], root);
    if (proof === undefined) outsideScope();
    return proof;
  }

  async #proveNativeFile(fileId: string, expectedMimeType: string): Promise<FolderProof> {
    let root = await this.#getFolderRoot();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId || file.mimeType !== expectedMimeType) outsideScope();
    return this.#proveFile(file, root);
  }

  async #assertParent(parentId: string): Promise<void> {
    if (this.#scope.kind === "file") outsideScope();
    let parent = await this.#getFileInScope(parentId);
    await this.#authorizeIds([parent.id], "Check Google Drive folder",
      "Check that the requested parent folder belongs to this Drive binding.");
    if (parent.mimeType !== FOLDER_MIME_TYPE) throw new Error("directParentId must identify a folder");
  }

  async #getFileInScope(fileId: string): Promise<DriveFile> {
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    if (this.#scope.kind === "folder") {
      let proof = await this.#proveFile(file, await this.#getFolderRoot());
      await this.#folder.recheck([proof]);
      return file;
    }
    if (!this.#inScope(file)) outsideScope();
    return file;
  }

  /** `files.get`, translating a denial into this binding's refusal where that is what it means. */
  async #fetchFile(fileId: string): Promise<DriveFile> {
    try {
      return await this.#api.getFile(fileId);
    } catch (err) {
      if (err instanceof DriveApiRequestError && !err.isAccountWide &&
          (err.status === 403 || err.status === 404)) {
        if (this.#scope.kind === "sharedDrive" || this.#scope.kind === "folder") outsideScope();
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
  }

  async #authorizeIds(fileIds: string[], title: string, description: string): Promise<void> {
    let check = await this.#prepareObservation(fileIds);
    await this.#authorize({ title, description, excludeObservers: check.excludeObservers });
    check.commit();
  }
}
