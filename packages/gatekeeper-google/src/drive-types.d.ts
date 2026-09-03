import type { GoogleDocReadSession } from "./docs-read-types";
import type { GoogleSpreadsheetReadSession } from "./sheets-types";

/**
 * A pagination cursor.
 *
 * This is an RPC object. Call `next()` repeatedly on the same cursor to fetch subsequent batches,
 * and dispose the cursor when finished. Drain it until `next()` returns `null`: an empty array
 * means this call ran out of budget while filtering, not that there is nothing left.
 */
export interface Cursor<T> {
  /** The next batch, `[]` when this call found none but more remain, or `null` once exhausted. */
  next(): Promise<T[] | null>;
}

/**
 * The immutable resource scope of a Google Drive binding.
 *
 * Account scope is everything the connected account can read in Drive, including files in shared
 * drives. `list()` and `search()` cover My Drive plus shared-drive items the account has accessed;
 * `getEntry()` resolves any ID the account can read, so a file may be readable by ID without ever
 * appearing in a listing. Shared-drive scope means a Google Workspace shared drive, not an
 * ordinary or shared folder; its files belong to the organization rather than an individual.
 *
 * Folder scope is one folder plus every file and folder currently beneath it, at any depth. The
 * folder may live in My Drive — including one someone else shared from theirs — or inside a shared
 * drive; a shared drive's own root is not a folder binding, it is the shared-drive scope. Every
 * operation re-derives membership from live Drive metadata, so an item that moves out stops being
 * readable, one that moves in becomes readable, and a shortcut is listed but never followed to its
 * target. `parentId` is withheld for the bound folder itself, since its container is outside the
 * binding.
 *
 * Names are current display metadata; stable IDs are capability identity.
 */
export type DriveScope =
  | { kind: "account" }
  | { kind: "sharedDrive"; driveId: string; name: string }
  | { kind: "folder"; folderId: string; name: string }
  | { kind: "file"; fileId: string; name: string };

/** Owner metadata for a Drive entry. Absent for items in shared drives. */
export type DriveOwner = {
  /** The owner's current display name, when available. */
  displayName?: string;
  /** The owner's email address, when available. */
  emailAddress?: string;
};

/** Metadata about a Drive shortcut's target. The shortcut is not followed. */
export type DriveShortcut = {
  /** Stable ID recorded for the shortcut target. */
  targetId: string;
  /** Drive's creation-time MIME type snapshot, not current authority for the target. */
  targetMimeType?: string;
};

/**
 * Read-only metadata for one entry within the immutable binding scope.
 *
 * `list()` and `search()` never return trashed items. `getEntry()` can, and this type does not
 * say whether they are — there is no `trashed` field.
 */
export type DriveEntry = {
  /** Stable Drive file ID. */
  id: string;
  /** Current display name. */
  name: string;
  /** Current Drive MIME type. */
  mimeType: string;
  /** Whether this entry is a folder. */
  isFolder: boolean;
  /** Time the entry was last modified. */
  modifiedTime: Date;
  /** Size in bytes. Absent for folders and shortcuts. */
  size?: number;
  /** Owner metadata. Absent for items in shared drives. */
  owner?: DriveOwner;
  /** Direct parent ID. Absent when the entry is at a root. */
  parentId?: string;
  /** Shared-drive ID. Absent for entries outside shared drives. */
  driveId?: string;
  /** Browser URL for viewing the entry, when Drive provides one. */
  webViewLink?: string;
  /** Shortcut target metadata, present only for shortcuts. */
  shortcut?: DriveShortcut;
};

/** Supported ordering for Drive listing and structured search. */
export type DriveOrder =
  /** Most recently modified entries first. */
  | "modifiedTimeDesc"
  /** Least recently modified entries first. */
  | "modifiedTimeAsc"
  /** Names in ascending order. */
  | "nameAsc"
  /** Names in descending order. */
  | "nameDesc";

/** Options for listing entries within the binding scope. */
export type DriveListOptions = {
  /** Limit results to direct children of this folder; descendants are not included. */
  directParentId?: string;
  /** Result order. Defaults to most recently modified first. */
  order?: DriveOrder;
};

/**
 * Structured values for searching Drive metadata.
 *
 * Callers provide values only, never raw Drive query syntax. Populated filter fields are AND-ed;
 * values within `mimeTypes` are OR-ed.
 */
export type DriveSearchQuery = {
  /** Match entries whose name starts with this value. */
  namePrefix?: string;
  /**
   * Match entries whose indexed text contains this value.
   *
   * This is the one filter that reaches past metadata: Drive indexes a file's body text,
   * description and OCR text. Results still carry metadata alone.
   */
  fullTextContains?: string;
  /** Match entries having any one of these MIME types. */
  mimeTypes?: string[];
  /** Match entries modified after this RFC 3339 timestamp. */
  modifiedAfter?: string;
  /** Match entries modified before this RFC 3339 timestamp. */
  modifiedBefore?: string;
  /** Limit matches to direct children of this folder; descendants are not included. */
  directParentId?: string;
  /** Result order. Cannot be combined with `fullTextContains`. */
  order?: DriveOrder;
};

/**
 * Read-only metadata discovery and native Google Docs/Sheets access within the selected Drive scope.
 *
 * Every Drive binding provides this. Methods do not follow shortcut targets, edit Drive, or read
 * non-native file contents, and the native sessions they return are read-only.
 */
export interface GoogleDriveReadSession {
  /** Return the immutable binding scope with current display metadata. */
  getScope(): Promise<DriveScope>;

  /**
   * List entries in the binding scope, most recently modified first by default.
   *
   * A folder binding lists its whole subtree at every depth. `directParentId` narrows any binding
   * to one folder's direct children, never recursive descendants, and throws when that folder is
   * outside the binding scope.
   */
  list(options?: DriveListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search with structured values. At least one filter other than `order` is required. Populated filter
   * fields are AND-ed, while values within `mimeTypes` are OR-ed. `order` cannot be combined with
   * `fullTextContains`; omitting it for full-text search preserves Drive's relevance order.
   *
   * A folder binding searches its whole subtree; matches outside it are discarded before anything
   * is disclosed, so a page can come back empty with results still ahead — drain to `null`.
   *
   * Throws on a file-scoped binding; a single file cannot be searched. Use `getEntry()` to read it.
   * Also throws when no entries match because an owner-relative negative result cannot be shared safely.
   */
  search(query: DriveSearchQuery): Promise<Cursor<DriveEntry>>;

  /**
   * Return metadata for one file ID.
   *
   * A file binding throws without contacting Drive when the ID is not the bound file. A shared-drive
   * binding throws when the file is not in that drive. A folder binding throws unless the file is
   * currently inside its subtree. An account binding returns any file the connected account can
   * read, including files in shared drives it is a member of.
   *
   * Unlike `list()` and `search()`, this can return a trashed file: those methods always exclude
   * trash, while a direct get does not, and {@link DriveEntry} has no `trashed` field. A folder
   * binding is the exception — trash is outside its subtree, so it throws instead.
   */
  getEntry(fileId: string): Promise<DriveEntry>;

  /**
   * Open an in-scope native Google Doc with MIME type
   * `application/vnd.google-apps.document`. Other MIME types, including folders and shortcuts, are
   * rejected. The returned RPC capability supports promise pipelining and must be disposed when
   * finished.
   *
   * A folder binding re-proves the file's place in the subtree on every call the returned session
   * makes, so a document moved out stops answering even through an already-open session.
   */
  openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>;

  /**
   * Open an in-scope native Google Sheet with MIME type
   * `application/vnd.google-apps.spreadsheet`. Other MIME types, including folders and shortcuts,
   * are rejected. The returned RPC capability supports promise pipelining and must be disposed when
   * finished.
   *
   * A folder binding re-proves the file's place in the subtree on every call the returned session
   * makes, so a spreadsheet moved out stops answering even through an already-open session.
   */
  openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>;
}

/** The access provided by an account, shared-drive, or folder binding. */
export type GoogleDriveSession = GoogleDriveReadSession;
