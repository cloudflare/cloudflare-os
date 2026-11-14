import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { CursorPager, type Pager } from "./cursor";
import {
  FOLDER_MIME_TYPE, MAX_QUERY_PARENTS, MY_DRIVE_ROOT, SHORTCUT_MIME_TYPE,
  isFileInvisible, isInsufficientScope, isListableFolderFile, isListableFolderNode,
  type DriveApi, type DriveCommentList, type DriveFile, type DriveListFilesOptions,
  type DriveScopeNode,
} from "./drive-api";
import {
  isDirectChild, outsideScope, readFolderLocation,
  type FolderLocation,
} from "./drive-folder-scope";
import type { DriveObservation } from "./drive-observers";
import { fileSubresourceIds, type FileSubresource } from "./file-subresources";
import type {
  DriveBindingAccess, DriveComment, DriveEntry, DriveFolderListOptions, DriveFolderSearchQuery,
  DriveListOptions, DriveOrder, DriveScope, DriveSearchQuery,
} from "./drive-types";

/** Exact MIME type for native Google Docs files. */
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
/** Exact MIME type for native Google Sheets files. */
export const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
/** Exact MIME type for native Google Slides files. */
export const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
/** Exact MIME type Drive gives a PDF. */
export const PDF_MIME_TYPE = "application/pdf";

const FOLDER_MOVED = "The connected Drive folder moved to another drive; open a new listing.";

const SHARED_DRIVE_ROOT =
  "A shared drive's own sharing is its membership, which is neither listed nor changed here. " +
  "Its members are listed as inherited access on any file or folder in the drive.";
const MY_DRIVE_ROOT_SHARING =
  "The top level of My Drive itself is neither listed nor shared here. Share a file or a folder " +
  "in it instead.";

/** The refusal of a move on a single-file binding, which has no second folder to move into. */
export const MOVE_SINGLE_FILE =
  "A single-file Drive binding cannot move its file. Moving takes a folder binding that holds " +
  "both the folder the file is in and the folder it goes to, or an all-of-Drive binding, with " +
  "read and write access.";
/** The refusal of a move whose destination is the file itself. */
export const MOVE_INTO_ITSELF = "A folder cannot be moved into itself.";
const MOVE_ALREADY_THERE = "That file is already in that folder.";
const MOVE_TRASHED = "That file is in the trash, so it cannot be moved.";
const MOVE_NOT_ONE_FOLDER =
  "That file is not in exactly one folder the connected account can see, so it cannot be moved " +
  "here.";
const MOVE_OTHER_DRIVE =
  "Moving between drives is not supported: the file and the folder must be in the same shared " +
  "drive, or both outside shared drives.";
const MOVE_NOT_A_FOLDER = "The destination is not a folder.";
const MOVE_INTO_TRASH = "That folder is in the trash, so nothing can be moved into it.";
const MOVE_FOLDER_DESTINATION =
  "That is not a folder this binding can move into: the destination is a direct child folder of " +
  "the positioned folder, or getScope().parentFolderId. A folder further away inside the " +
  "connected folder is reached one level per move, each from the session of the folder the file " +
  "is then in; one outside it takes a binding to a folder that holds both ends, or to all of " +
  "Drive.";
const MOVE_CANNOT_ADD = "The connected account cannot add files to that folder.";

function cannotMoveFile(fileId: string): string {
  return `The connected account cannot move Drive file ${fileId}.`;
}

const MOVE_TITLE = "Check Google Drive move";

/** What a move's scope proof says it checks, with both IDs as Drive answered them. */
function moveDescription(fileId: string, folderId: string): string {
  return `Check that Drive file ${fileId} can be moved into folder ${folderId}.`;
}

/** The refusal of a destination a folder binding cannot move into. */
function refuseFolderDestination(): never {
  throw new Error(MOVE_FOLDER_DESTINATION);
}

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
type DriveSessionApi = Pick<
  DriveApi, "listFiles" | "getFile" | "getScopeNodes" | "canComment" | "canShare" | "listComments"
>;
/** A page's proven scope: the bound drive, and the parents its files must sit directly under. */
type FolderPageScope = {driveId: string | undefined; parents: DriveScopeNode[]};

/**
 * An observation description before the read reports what it depends on: the {@link NativeRead}
 * adds the subresources, and any observer exclusions, itself.
 */
export type NativeObservation = Omit<ObservationDescription, "excludeObservers" | "subresources">;

/**
 * Authorizes one disclosure. `subresources` is required because nothing else records what a Drive,
 * Docs, Sheets or Slides read depends on: an observation without it would leave later observers
 * unchecked against what it read.
 */
export type SubresourceAuthorizer =
  (description: ObservationDescription & {subresources: string[]}) => Promise<void>;

/**
 * Performs one Docs, Sheets, Slides, PDF or file content read and authorizes it before the value
 * is disclosed, reporting the file it read (see file-subresources.ts) and whatever its scope
 * check proved.
 *
 * The fetch is a thunk rather than a value so a scope check can refuse before the provider is
 * contacted at all.
 */
export type NativeRead = <T>(
  fetch: () => Promise<T>,
  observe: (value: T) => NativeObservation,
) => Promise<T>;

/** How a session core's `nativeRead` treats one read. */
export type NativeReadOptions = {
  /**
   * Discloses the file's content -- its bytes or a PDF's text -- rather than what a viewer sees, so
   * the read reports the file's content, which an observer passes only with leave to download.
   */
  content?: boolean;
  /**
   * Folder bindings only: sees the file's metadata from each re-proof, before and after the fetch,
   * and throws to refuse a read of a file that has changed since it was opened.
   */
  unchanged?: (file: DriveFile) => void;
};

/**
 * Reads and authorizes with no live scope check, for a binding whose scope cannot move. Every read
 * reports `subresources`: the file it reads, or none for one not created yet.
 */
export function unguardedNativeRead(
  authorize: SubresourceAuthorizer,
  subresources: readonly FileSubresource[],
): NativeRead {
  let ids = fileSubresourceIds(subresources);
  return async <T>(fetch: () => Promise<T>, observe: (value: T) => NativeObservation) => {
    let value = await fetch();
    await authorize({...observe(value), subresources: ids});
    return value;
  };
}

/**
 * What a read of Drive file `fileId` reads: the file's content when Drive downloads it, and
 * otherwise the Doc, Sheet or Slides presentation its own API names.
 */
function nativeSubresource(fileId: string, mimeType: string, content = false): FileSubresource {
  if (content) return {kind: "content", fileId};
  switch (mimeType) {
    case GOOGLE_DOC_MIME_TYPE: return {kind: "document", fileId};
    case GOOGLE_SHEET_MIME_TYPE: return {kind: "spreadsheet", fileId};
    case GOOGLE_SLIDES_MIME_TYPE: return {kind: "presentation", fileId};
  }
  throw new Error(`Google Drive has no native read of ${mimeType} files.`);
}

/**
 * Everything one Drive session core enforces and reports through.
 *
 * `authorize` is part of the construction because it is the one thing that differs between the
 * cores a session builds: they share its scope, but a capability handed to the caller -- a cursor,
 * a native child -- authorizes through an approval queue with its own lifetime.
 */
export type DriveSessionCoreOptions = {
  api: DriveSessionApi;
  scope: DriveSessionScope;
  /** The binding's access, which `getScope()` reports with its scope. */
  access: DriveBindingAccess;
  authorize: SubresourceAuthorizer;
};

/** Construction contract for one positioned folder capability core. */
export type DriveFolderSessionCoreOptions = Omit<DriveSessionCoreOptions, "scope"> & {
  location: FolderLocation;
};

/** Either core a Drive session can be driving. */
export type DriveCore = DriveSessionCore | DriveFolderSessionCore;

/** An in-scope file or folder a write is about to be queued on, as its scope check found it. */
export type DriveWriteTarget = {
  fileId: string;
  /** The target's current name, which a write's approval shows beside its ID. */
  name: string;
  mimeType?: string;
  /** Whether it is a folder, so that sharing it shares what it holds. */
  isFolder: boolean;
  /**
   * Folder binding: the path from the bound root to the target's parent, or, with `self`, to it.
   */
  folderIds?: string[];
  /** Folder binding: the target is the positioned folder itself. */
  self?: true;
};

/**
 * What a write target is proved for: the observation's wording, and whether the positioned folder
 * itself counts.
 */
type TargetPurpose = { title: string; noun: "comments" | "sharing"; allowSelf: boolean };

const COMMENT_TARGET: TargetPurpose =
  { title: "Open Google Drive comments", noun: "comments", allowSelf: false };
const SHARING_TARGET: TargetPurpose =
  { title: "Open Google Drive sharing", noun: "sharing", allowSelf: true };

/** A file as a write's scope check found it, with the folder binding's `path` to it. */
function writeTarget(
  file: DriveFile, path?: Pick<DriveWriteTarget, "folderIds" | "self">,
): DriveWriteTarget {
  return {
    fileId: file.id,
    name: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    isFolder: file.mimeType === FOLDER_MIME_TYPE,
    ...path,
  };
}

/** A move as its scope check found it: the file, the folder it is in, and the folder it goes to. */
export type DriveMoveTarget = {
  fileId: string;
  /** The file's current name. */
  name: string;
  /** Whether it is a folder, so that everything in it moves with it. */
  isFolder: boolean;
  /** The folder the file is in. */
  fromFolderId: string;
  /** The folder the file goes to, by its own ID however the caller named it. */
  toFolderId: string;
  /** The destination's name. Absent for the connected account's own My Drive root. */
  toName?: string;
  /** Folder binding: the positioned folder's name, which that session's reads already report. */
  fromName?: string;
  /** The source is the connected account's own My Drive root, which no observation reports. */
  fromMyDrive?: true;
  /** The destination is the connected account's own My Drive root, which no observation reports. */
  toMyDrive?: true;
  /** Folder binding: the path from the bound root to the positioned folder, which is the source. */
  folderIds?: string[];
};

/** One page of a file's comments, as the caller sees it. */
export type CommentPage = {
  comments: DriveComment[];
  nextPageToken?: string;
  /**
   * Whether the page shows what this binding read from the file as a Google Doc: a comment
   * awaiting approval that quotes it. Such a page reports the document as well.
   */
  quotesDocument?: boolean;
};

/**
 * Fetches one page of a file's comments with `fetch` and maps it to what the caller sees, with
 * whatever this binding has queued for the file.
 */
export type CommentPageReader = (fetch: () => Promise<DriveCommentList>) => Promise<CommentPage>;

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

/**
 * The disclosure protocol both cores run: reporting the Drive units each read depends on, and the
 * per-page authorization rule.
 *
 * Shared rather than copied because what a page reports is security-relevant, and two copies of a
 * security rule drift without saying so.
 */
abstract class DriveCoreBase {
  protected readonly api: DriveSessionApi;
  protected readonly access: DriveBindingAccess;
  protected readonly authorize: SubresourceAuthorizer;

  constructor(options: Omit<DriveSessionCoreOptions, "scope">) {
    this.api = options.api;
    this.access = options.access;
    this.authorize = options.authorize;
  }

  /** Authorize one disclosure, reporting every unit in `observations` as a subresource. */
  protected authorizeUnits(
    observations: DriveObservation[], title: string, description: string,
  ): Promise<void> {
    return this.authorize({title, description, subresources: fileSubresourceIds(observations)});
  }

  /** {@link authorizeUnits} for plain file IDs. */
  protected authorizeFiles(
    fileIds: readonly string[], title: string, description: string,
  ): Promise<void> {
    return this.authorizeUnits(
      fileIds.map(fileId => ({kind: "file", fileId})), title, description);
  }

  /**
   * Authorize a read whose answer is relative to the connected account rather than to any file,
   * such as that it cannot list a folder or see a file. Nothing restricts who may see that, so it
   * reports no subresources.
   */
  protected authorizeAccountRelative(title: string, description: string): Promise<void> {
    return this.authorize({title, description, subresources: []});
  }

  /** Validate one file against this scope and authorize opening it as a `description`. */
  abstract openFile(fileId: string, description: string): Promise<DriveFile>;

  /** {@link openFile} for a native file of one type, before a nested content session is created. */
  async openNative(
    fileId: string,
    expectedMimeType: string,
    description: string,
  ): Promise<DriveFile> {
    let file = await this.openFile(fileId, description);
    if (file.mimeType !== expectedMimeType) {
      throw new Error(`The requested Drive file is not a ${description}.`);
    }
    return file;
  }

  /** {@link openNative}, answering only the file's ID. */
  async openNativeFile(
    fileId: string,
    expectedMimeType: string,
    description: string,
  ): Promise<string> {
    return (await this.openNative(fileId, expectedMimeType, description)).id;
  }

  /**
   * Refuses a file the connected account can only view. Google shows a file's comments only to
   * accounts that can comment on it, and answers the listing of an account that can only view the
   * file with none, which would read as a file without comments. The check is about the connected
   * account alone, so a file it can comment on observes nothing, and a refusal is reported with no
   * subresource. A failure of the check itself leaves as it came, with nothing reported.
   */
  async requireCommentable(fileId: string): Promise<void> {
    if (await this.api.canComment(fileId)) return;
    await this.authorizeAccountRelative("Check Google Drive file access",
      `Check whether the connected account can comment on Drive file ${fileId}.`);
    throw new Error(`The connected account can only view Drive file ${fileId}. Google shows a ` +
      "file's comments only to accounts that can comment on it, so this file's comments cannot " +
      "be read or added to here.");
  }

  /**
   * Refuses a file the connected account cannot share. Google refuses a file's permission list,
   * and a change to it, to an account that cannot share the file. The check is about the connected
   * account alone, so a file it can share observes nothing, and a refusal is reported with no
   * subresource. A file the account can no longer see is refused the same way; any other failure
   * of the check leaves as it came, with nothing reported.
   */
  async requireShareable(fileId: string): Promise<void> {
    let allowed = await this.api.canShare(fileId).catch((error: unknown) => {
      // Gone since the scope check: as much the account's own answer as "cannot share".
      if (isInsufficientScope(error) || !isFileInvisible(error)) throw error;
      return false;
    });
    if (allowed) return;
    await this.authorizeAccountRelative("Check Google Drive file access",
      `Check whether the connected account can change who has access to Drive file ${fileId}.`);
    throw new Error(`The connected account cannot change who has access to Drive file ${fileId}, ` +
      "so its sharing cannot be read or changed here.");
  }

  /**
   * A reader of the connected account's own My Drive root, under Drive's alias for it, which asks
   * Drive once however often one scope proof asks it.
   */
  protected myDriveRootReader(): () => Promise<DriveFile> {
    let root: Promise<DriveFile> | undefined;
    return () => (root ??= this.api.getFile(MY_DRIVE_ROOT));
  }

  /**
   * Whether `folder` is the connected account's own My Drive root, which no other account can see.
   * Only a folder with no parent and outside every shared drive can be, and a folder shared with
   * the account whose parent it cannot see is such a folder too, so the root is read and the IDs
   * are compared.
   */
  protected async isOwnMyDriveRoot(
    folder: DriveFile, readRoot: () => Promise<DriveFile> = this.myDriveRootReader(),
  ): Promise<boolean> {
    if (folder.mimeType !== FOLDER_MIME_TYPE || folder.parents?.length || folder.driveId) {
      return false;
    }
    return (await readRoot()).id === folder.id;
  }

  /**
   * Authorizes the scope proof of a write target, reporting `units`: what reading the file
   * reports. A sharing target has two refusals of its own. The connected account's own My Drive
   * root is refused before anything is reported, relative to that account: no other account can
   * see that folder, so its unit would be a requirement nobody passes. A shared drive's root is
   * refused after its units are reported: that it is one is the file's own metadata.
   */
  protected async authorizeTarget(
    file: DriveFile, units: DriveObservation[], purpose: TargetPurpose,
  ): Promise<void> {
    let sharing = purpose.noun === "sharing";
    let description =
      `Check current metadata for Drive file ${file.id} to work with its ${purpose.noun}.`;
    if (sharing && await this.isOwnMyDriveRoot(file)) {
      await this.authorizeAccountRelative(purpose.title, description);
      throw new Error(MY_DRIVE_ROOT_SHARING);
    }
    await this.authorizeUnits(units, purpose.title, description);
    if (sharing && file.driveId === file.id) throw new Error(SHARED_DRIVE_ROOT);
  }

  /** Authorizes handing the caller `count` ways of access to file `fileId`, reporting `units`. */
  protected authorizeAccess(
    units: DriveObservation[], fileId: string, count: number,
  ): Promise<void> {
    return this.authorizeUnits(units, "Read Google Drive sharing",
      `Read ${count} ${count === 1 ? "way" : "ways"} of access to Drive file ${fileId}.`);
  }

  /**
   * Refuses a move the connected account may not make: it must be able to move the file within
   * its drive and to add to the destination, both read in one batch. Either answer is that
   * account's own, so the refusal is the call's one report and names no subresource.
   */
  protected async requireMovable(
    fileId: string, folderId: string, description: string,
  ): Promise<void> {
    let [file, folder] = await this.api.getScopeNodes([fileId, folderId]);
    let refusal: string | undefined;
    if (file?.canMoveItemWithinDrive !== true) refusal = cannotMoveFile(fileId);
    else if (folder?.canAddChildren !== true) refusal = MOVE_CANNOT_ADD;
    if (refusal === undefined) return;
    await this.authorizeAccountRelative(MOVE_TITLE, description);
    throw new Error(refusal);
  }

  /**
   * Pages through a file's comments, reporting each page with `units`, which are what reading the
   * file reports, and with the document when the page shows a comment that quotes it. `revalidate`
   * runs before each fetch and again after it, where the file can leave scope.
   */
  protected commentPages(
    fileId: string,
    units: readonly DriveObservation[],
    readPage: CommentPageReader,
    revalidate?: () => Promise<unknown>,
  ): Pager<DriveComment> {
    // Whether the page fetched last shows a comment quoting the document. The cursor runs its
    // calls one at a time and offers only the page it fetched last, having walked past those that
    // hold no comment, so an authorization reads what its own page showed: never what a call that
    // failed, or was refused, fetched and did not disclose.
    let quotesDocument = false;
    return new CursorPager<DriveComment, DriveComment>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        await revalidate?.();
        let page = await readPage(
          () => this.api.listComments(fileId, pageToken ? {pageToken} : {}));
        quotesDocument = page.quotesDocument === true;
        return {
          items: page.comments, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {}),
        };
      },
      buildEntries: async comments => {
        await revalidate?.();
        return comments;
      },
      authorize: async comments => {
        let document: FileSubresource[] = quotesDocument ? [{kind: "document", fileId}] : [];
        await this.authorize({
          title: "Read Google Drive comments",
          description: `Read ${comments.length} ${comments.length === 1 ? "comment" : "comments"} ` +
            `on Drive file ${fileId}.`,
          subresources: fileSubresourceIds([...units, ...document]),
        });
      },
    });
  }

  /** Current metadata for one file, or `undefined` when it is invisible to this account. */
  protected async tryFetchFile(fileId: string): Promise<DriveFile | undefined> {
    try {
      return await this.api.getFile(fileId);
    } catch (error) {
      if (isInsufficientScope(error)) throw error;
      if (isFileInvisible(error)) return undefined;
      throw error;
    }
  }

  /**
   * The per-page authorization rule: disclose the page, empty or not.
   *
   * `revalidate` runs first where the scope can move under the cursor, and `baseUnits` are the
   * units every page of that scope also discloses.
   */
  protected pageAuthorizer(
    scope: DriveBindingScope,
    query: DriveListFilesOptions,
    options: {
      revalidate?: () => Promise<unknown>;
      baseUnits?: readonly DriveObservation[];
    } = {},
  ): (entries: DriveEntry[]) => Promise<void> {
    return async entries => {
      await options.revalidate?.();
      await this.authorizeUnits(
        [
          ...(options.baseUnits ?? []),
          ...entries.map(entry => ({kind: "file" as const, fileId: entry.id})),
        ],
        "Read Google Drive metadata",
        listingDescription(scope, query, entries.length),
      );
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
    if (this.#scope.kind === "account") return {kind: "account", access: this.access};
    let file = await this.#fetchFile(this.#scope.fileId);
    if (file.id !== this.#scope.fileId) outsideScope();
    await this.authorizeFiles([file.id], "Read Google Drive scope",
      "Read the current name of the connected Drive file.");
    return {kind: "file", fileId: file.id, name: file.name, access: this.access};
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
    });
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    await this.authorizeFiles([file.id], "Read Google Drive metadata",
      `Read metadata for Drive file ${file.id}.`);
    return driveFileToEntry(file);
  }

  async openFile(fileId: string, description: string): Promise<DriveFile> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    await this.authorizeFiles([file.id], `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`);
    return file;
  }

  /**
   * An account or exact-file capability's scope cannot move, so its reads need no live scope check
   * and re-read no metadata for `unchanged` to see. Each reports the file it reads;
   * openNativeFile() already reported its Drive metadata.
   */
  nativeRead(
    fileId: string, expectedMimeType: string, {content}: NativeReadOptions = {},
  ): NativeRead {
    return unguardedNativeRead(
      this.authorize, [nativeSubresource(fileId, expectedMimeType, content)]);
  }

  /** Validate and authorize one file whose comments are about to be read or written. */
  async commentTarget(fileId: string): Promise<DriveWriteTarget> {
    return this.#writeTarget(fileId, COMMENT_TARGET);
  }

  /** Validate and authorize one file or folder whose sharing is about to be read or changed. */
  async sharingTarget(fileId: string): Promise<DriveWriteTarget> {
    return this.#writeTarget(fileId, SHARING_TARGET);
  }

  /**
   * Proves a {@link sharingTarget} again once its permissions are read. This binding reaches a
   * file by its ID wherever the file is, so nothing that happened during the read is left to prove.
   */
  revalidateSharingTarget(_target: DriveWriteTarget): Promise<void> {
    return Promise.resolve();
  }

  /** Authorize handing the caller `count` ways of access to a {@link sharingTarget}. */
  authorizeAccessList(target: DriveWriteTarget, count: number): Promise<void> {
    return this.authorizeAccess([{kind: "file", fileId: target.fileId}], target.fileId, count);
  }

  /** The scope proof of a write target: a file this binding reaches, under the ID asked for. */
  async #writeTarget(fileId: string, purpose: TargetPurpose): Promise<DriveWriteTarget> {
    if (this.#scope.kind === "file" && fileId !== this.#scope.fileId) outsideScope();
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    await this.authorizeTarget(file, [{kind: "file", fileId: file.id}], purpose);
    return writeTarget(file);
  }

  /**
   * Validate and authorize moving one file or folder into `folderId`, which may name the top level
   * of the account's own My Drive by Drive's alias for it.
   *
   * The call reports once. An objective fact about the file or the destination is reported with
   * the units it is a fact about, and so is a move that is proved. What the connected account
   * alone answers (a file in no folder it can see, a move it may not make) reports no subresource.
   * The folder the file leaves is never reported, and neither is the account's own My Drive root:
   * no other account can see that folder.
   */
  async moveTarget(fileId: string, folderId: string): Promise<DriveMoveTarget> {
    if (this.#scope.kind === "file") throw new Error(MOVE_SINGLE_FILE);
    if (folderId === fileId) throw new Error(MOVE_INTO_ITSELF);
    let file = await this.#fetchFile(fileId);
    if (file.id !== fileId) outsideScope();
    // The alias is resolved here and the root is held by its own ID from here on: a batched read
    // of the alias answers under another ID than the one asked for.
    let readRoot = this.myDriveRootReader();
    let aliased = folderId === MY_DRIVE_ROOT;
    let destination = aliased ? await readRoot() : await this.#fetchFile(folderId);
    if (!aliased && destination.id !== folderId) outsideScope();

    let description = moveDescription(file.id, destination.id);
    // An objective fact about the files named, which are reported before it is said.
    let refuse = async (fileIds: readonly string[], message: string): Promise<never> => {
      await this.authorizeFiles(fileIds, MOVE_TITLE, description);
      throw new Error(message);
    };
    // The connected account's own answer, which no other account's access decides.
    let refuseAccountRelative = async (message: string): Promise<never> => {
      await this.authorizeAccountRelative(MOVE_TITLE, description);
      throw new Error(message);
    };

    // A file reads as live only when Drive says so, as everywhere a scope is proved.
    if (file.trashed !== false) return refuse([file.id], MOVE_TRASHED);
    let parents = file.parents ?? [];
    if (parents.length > 1) return refuse([file.id], MOVE_NOT_ONE_FOLDER);
    // Drive lists no parent for a file shared from a folder this account cannot see, so a file
    // with none is this account's answer, as a parent it cannot see is.
    if (!parents.length) return refuseAccountRelative(MOVE_NOT_ONE_FOLDER);
    let source = await this.tryFetchFile(parents[0]);
    if (!source || source.id !== parents[0]) return refuseAccountRelative(MOVE_NOT_ONE_FOLDER);
    // A folder put in the trash says so some seconds before what it holds does, and a file moved
    // out in those seconds lands in its destination in the trash.
    if (source.trashed !== false) return refuse([file.id], MOVE_TRASHED);

    let fromMyDrive = await this.isOwnMyDriveRoot(source, readRoot);
    let toMyDrive = aliased || await this.isOwnMyDriveRoot(destination, readRoot);
    let reported = toMyDrive ? [file.id] : [file.id, destination.id];
    if (destination.mimeType !== FOLDER_MIME_TYPE) return refuse(reported, MOVE_NOT_A_FOLDER);
    // Google would make this move, and the file would then read as live in a folder no listing
    // shows, so the refusal is this binding's own and says the cause.
    if (destination.trashed !== false) return refuse(reported, MOVE_INTO_TRASH);
    if (destination.id === source.id) return refuse(reported, MOVE_ALREADY_THERE);
    // Both outside every shared drive counts as the same drive.
    if (destination.driveId !== file.driveId) return refuse(reported, MOVE_OTHER_DRIVE);

    await this.requireMovable(file.id, destination.id, description);
    await this.authorizeFiles(reported, MOVE_TITLE, description);
    return {
      fileId: file.id,
      name: file.name,
      isFolder: file.mimeType === FOLDER_MIME_TYPE,
      fromFolderId: source.id,
      toFolderId: destination.id,
      ...(toMyDrive ? {toMyDrive: true} : {toName: destination.name}),
      ...(fromMyDrive ? {fromMyDrive: true} : {}),
    };
  }

  /** A {@link commentTarget}'s comments, page by page. */
  commentPager(fileId: string, readPage: CommentPageReader): Pager<DriveComment> {
    return this.commentPages(fileId, [{kind: "file", fileId}], readPage);
  }

  async #cursor(query: DriveListFilesOptions): Promise<Pager<DriveEntry>> {
    return new CursorPager<DriveFile, DriveEntry>({
      provider: "Google Drive",
      fetchPage: async pageToken => {
        let page = await this.api.listFiles({...query, corpus: {kind: "user"}, pageToken});
        return {items: page.files, ...(page.nextPageToken ? {nextPageToken: page.nextPageToken} : {})};
      },
      buildEntries: async files => files.map(file => driveFileToEntry(file)),
      authorize: this.pageAuthorizer(this.#scope, query),
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
      // On a live folder only `canListChildren` is relative to the connected account; a
      // non-folder or a trashed one is an objective refusal a listing would disclose anyway.
      if (parent.mimeType === FOLDER_MIME_TYPE && parent.trashed === false) {
        await this.authorizeAccountRelative(title, description);
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
   * Report an account-relative refusal without retaining an unsatisfiable file requirement.
   * Hide Google's per-file reason so a failed probe discloses no file metadata.
   */
  async #fetchFile(fileId: string): Promise<DriveFile> {
    try {
      return await this.api.getFile(fileId);
    } catch (error) {
      // A missing OAuth scope is an account-wide failure, not an invisible-file result.
      if (isInsufficientScope(error)) throw error;
      if (this.#scope.kind === "account" && isFileInvisible(error)) {
        await this.authorizeAccountRelative("Check Google Drive file access",
          `Check whether the connected account can access Drive file ${fileId}.`);
        // Do not expose the provider's file-specific reason through the RPC error's cause.
        // eslint-disable-next-line preserve-caught-error
        throw new Error("The requested Drive file is unavailable to the connected account.");
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
    let folderIds = this.#location.folderIds;
    return {
      kind: "folder", folderId: folder.id, rootFolderId: this.#rootId(),
      ...(folderIds.length > 1 ? {parentFolderId: folderIds[folderIds.length - 2]} : {}),
      name: folder.name, access: this.access,
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
    }, children);
  }

  async getEntry(fileId: string): Promise<DriveEntry> {
    let file = await this.#requireDirectFile(fileId);
    await this.authorizeUnits(
      [this.#folderObservation(), {kind: "file", fileId: file.id}],
      "Read Google Drive metadata", `Read metadata for Drive file ${file.id}.`);
    return driveFileToEntry(file);
  }

  /** Only a live direct child of the positioned folder can be opened. */
  async openFile(fileId: string, description: string): Promise<DriveFile> {
    let file = await this.#requireDirectFile(fileId);
    await this.authorizeUnits(
      [this.#folderObservation(), {kind: "file", fileId: file.id}],
      `Open ${description} from Google Drive`,
      `Check current metadata for Drive file ${file.id} and open it as a ${description}.`,
    );
    return file;
  }

  /**
   * Disclose why a folder cannot stand as a parent here, then refuse, with `refuse`.
   *
   * Only `canListChildren` is relative to the connected account; a non-folder or a trashed one is
   * an objective refusal `list()` would disclose anyway, so it is reported as a file unit.
   */
  async #refuseUnlistable(
    node: DriveScopeNode, refuse: () => never = outsideScope,
  ): Promise<never> {
    let title = "Check Google Drive folder";
    let description = "Check whether a requested folder can be opened here.";
    if (node.mimeType === FOLDER_MIME_TYPE) await this.authorizeAccountRelative(title, description);
    else {
      await this.authorizeUnits(
        [this.#folderObservation(), {kind: "file", fileId: node.id}], title, description);
    }
    refuse();
  }

  /**
   * One live direct child that is a folder whose children can be listed, which is what a folder
   * must be to be opened or moved into here. Any other answer about `folderId` is disclosed as
   * {@link #requireDirectFile} and {@link #refuseUnlistable} disclose it, then refused with
   * `refuse`.
   */
  async #requireChildFolder(
    folderId: string, refuse: () => never = outsideScope,
  ): Promise<DriveFile> {
    let folder = await this.#requireDirectFile(folderId, refuse);
    if (!isListableFolderFile(folder)) await this.#refuseUnlistable(folder, refuse);
    return folder;
  }

  /** Open one live, listable direct child folder and append its checked path edge. */
  async openFolder(folderId: string): Promise<FolderLocation> {
    let folder = await this.#requireChildFolder(folderId);
    await this.authorizeUnits(
      [this.#folderObservation(), {kind: "folder", fileId: folder.id}],
      "Open Google Drive folder", `Open direct child folder ${folder.id}.`);
    return {folderIds: [...this.#location.folderIds, folder.id]};
  }

  /** Validate and authorize one direct child whose comments are about to be read or written. */
  async commentTarget(fileId: string): Promise<DriveWriteTarget> {
    return this.#writeTarget(fileId, COMMENT_TARGET);
  }

  /**
   * Validate and authorize one direct child, or the positioned folder itself, whose sharing is
   * about to be read or changed.
   */
  async sharingTarget(fileId: string): Promise<DriveWriteTarget> {
    return this.#writeTarget(fileId, SHARING_TARGET);
  }

  /**
   * Proves a {@link sharingTarget} again once its permissions are read: the saved path, and that
   * the target is still a live direct child or the positioned folder. A file moved out of the
   * folder during the read lists the sharing of the folder it went to, which is outside this
   * binding, so the call ends here, before anything is returned, refused or queued from that list.
   */
  async revalidateSharingTarget(target: DriveWriteTarget): Promise<void> {
    await this.#readTarget(target.fileId, target.self === true);
  }

  /** Authorize handing the caller `count` ways of access to a {@link sharingTarget}. */
  authorizeAccessList(target: DriveWriteTarget, count: number): Promise<void> {
    return this.authorizeAccess(
      [this.#folderObservation(), {kind: "file", fileId: target.fileId}], target.fileId, count);
  }

  /**
   * A write target as it stands now: a live direct child or, with `self`, the positioned folder,
   * with the saved path proved before the read and again after it.
   */
  async #readTarget(fileId: string, self: boolean): Promise<DriveFile> {
    if (!self) return this.#requireDirectFile(fileId);
    let folder = await this.#readCurrentFolder(await this.#readLocation());
    await this.#readLocation();
    return folder;
  }

  /**
   * The scope proof of a write target: a live direct child or, where the purpose allows it, the
   * positioned folder itself. Either reports the positioned folder and the target.
   */
  async #writeTarget(fileId: string, purpose: TargetPurpose): Promise<DriveWriteTarget> {
    let self = purpose.allowSelf && fileId === this.#currentFolderId();
    let file = await this.#readTarget(fileId, self);
    await this.authorizeTarget(
      file, [this.#folderObservation(), {kind: "file", fileId: file.id}], purpose);
    return writeTarget(
      file, {folderIds: [...this.#location.folderIds], ...(self ? {self: true} : {})});
  }

  /**
   * Validate and authorize moving one live direct child into `folderId`: a live direct child
   * folder that can be listed, or the folder this one was opened from. Nothing above the bound
   * root is reachable, since the root's saved path has no previous folder.
   *
   * A destination that is neither is refused after exactly what {@link openFolder} discloses of a
   * child it refuses. A move the connected account may not make reports no subresource, and a
   * move that is proved reports the positioned folder, the file and the destination. The
   * destination is left out when it is the connected account's own My Drive root, which a binding
   * connected to that folder has above its first child folders: no other account can see it.
   */
  async moveTarget(fileId: string, folderId: string): Promise<DriveMoveTarget> {
    if (folderId === fileId) throw new Error(MOVE_INTO_ITSELF);
    let file = await this.#requireDirectFile(fileId);
    let folderIds = this.#location.folderIds;
    let destination: DriveFile;
    let toMyDrive = false;
    if (folderIds.length > 1 && folderId === folderIds[folderIds.length - 2]) {
      // The saved path's previous folder, proved with the path. It is read for its name, and to
      // tell whether it is the account's own My Drive root, which a child folder never is.
      let previous = await this.tryFetchFile(folderId);
      if (!previous || previous.id !== folderId) outsideScope();
      destination = previous;
      toMyDrive = await this.isOwnMyDriveRoot(previous);
    } else {
      destination = await this.#requireChildFolder(folderId, refuseFolderDestination);
    }
    let description = moveDescription(file.id, destination.id);
    await this.requireMovable(file.id, destination.id, description);
    // The source is the positioned folder, whose name this session's reads already report. The
    // saved path is proved before that read and again after it, as for the folder's own scope.
    let source = await this.#readCurrentFolder(await this.#readLocation());
    await this.#readLocation();
    await this.authorizeUnits(
      [
        this.#folderObservation(), {kind: "file", fileId: file.id},
        ...(toMyDrive ? [] : [{kind: "file" as const, fileId: destination.id}]),
      ],
      MOVE_TITLE, description);
    return {
      fileId: file.id,
      name: file.name,
      isFolder: file.mimeType === FOLDER_MIME_TYPE,
      fromFolderId: source.id,
      toFolderId: destination.id,
      ...(toMyDrive ? {toMyDrive: true} : {toName: destination.name}),
      fromName: source.name,
      folderIds: [...folderIds],
    };
  }

  /**
   * A {@link commentTarget}'s comments, page by page. The saved path and the direct child are
   * proven before each fetch and again after it, so a file moved out mid-listing ends it.
   */
  commentPager(fileId: string, readPage: CommentPageReader): Pager<DriveComment> {
    return this.commentPages(fileId, [this.#folderObservation(), {kind: "file", fileId}], readPage,
      () => this.#requireDirectFile(fileId));
  }

  /**
   * Revalidate the saved path and direct child on every Docs, Sheets, Slides, PDF or file read,
   * which reports the folder it listed and the child it found there as well as the file it read.
   */
  nativeRead(
    fileId: string, expectedMimeType: string, {content, unchanged}: NativeReadOptions = {},
  ): NativeRead {
    let subresources = fileSubresourceIds([
      this.#folderObservation(), {kind: "file", fileId},
      nativeSubresource(fileId, expectedMimeType, content),
    ]);
    let requireCurrent = async () => {
      let file = await this.#requireDirectFile(fileId);
      if (file.mimeType !== expectedMimeType) outsideScope();
      unchanged?.(file);
    };
    return async <T>(fetch: () => Promise<T>, observe: (value: T) => NativeObservation) => {
      await requireCurrent();
      let value = await fetch();
      await requireCurrent();
      await this.authorize({...observe(value), subresources});
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
        {kind: "folder", folderId: this.#currentFolderId()}, audited,
        {revalidate: sinceFetch, baseUnits: [
          this.#folderObservation(),
          ...(childFolderIds ?? []).map(id => ({kind: "folder" as const, fileId: id})),
        ]}),
    });
  }

  /**
   * Prove every named folder is a listable direct child of `current`, in one batch.
   *
   * Same predicate as {@link openFolder}: invisible or live-but-unlistable is relative to the
   * connected account and reported with `subresources: []`, while a non-folder, a trashed one,
   * or a non-child is an objective refusal a listing of this folder would disclose anyway.
   */
  async #requireChildFolders(
    folderIds: readonly string[], current: DriveScopeNode,
  ): Promise<DriveScopeNode[]> {
    let nodes = await this.api.getScopeNodes(folderIds);
    for (let node of nodes) {
      if (!node) {
        await this.authorizeAccountRelative("Check Google Drive folder",
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

  /**
   * One live direct child of the positioned folder, with the saved path proved before the read
   * and again after it. An ID that names none is refused with `refuse`; a saved path that fails
   * its proof is outside the binding whatever was asked for.
   */
  async #requireDirectFile(
    fileId: string, refuse: () => never = outsideScope,
  ): Promise<DriveFile> {
    let path = await this.#readLocation();
    let file = await this.tryFetchFile(fileId);
    if (!file || file.id !== fileId) {
      // Invisible to this account, an answer relative to it alone. Whether a visible file is a
      // direct child is objective, so refusing that discloses nothing either.
      await this.authorizeAccountRelative(
        "Check Google Drive folder",
        "Check whether a requested file is a direct child of this Drive folder.");
      refuse();
    }
    if (!isDirectChild(file, path[path.length - 1])) refuse();
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
