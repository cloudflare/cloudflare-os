import type { GoogleDocReadSession } from "./docs-read-types";
import type { GoogleSpreadsheetReadSession } from "./sheets-types";

/**
 * A pagination cursor.
 *
 * This is an RPC object. Call `next()` repeatedly on the same cursor to fetch subsequent batches,
 * and dispose the cursor when finished.
 */
export interface Cursor<T> {
  /** Return the next batch of results, or `null` once the cursor is exhausted. */
  next(): Promise<T[] | null>;
}

/**
 * The immutable resource scope of a Google Drive binding.
 *
 * Account scope is everything the connected account can read in Drive, including files in shared
 * drives. `list()` and `search()` cover My Drive plus shared-drive items the account has accessed;
 * `getEntry()` resolves any ID the account can read, so a file may be readable by ID without ever
 * appearing in a listing. Shared-drive scope means a Google Workspace shared drive, not an
 * ordinary or shared folder; its files belong to the organization rather than an individual. Names
 * are current display metadata; stable IDs are capability identity.
 */
export type DriveScope =
  | { kind: "account" }
  | { kind: "sharedDrive"; driveId: string; name: string }
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
   * List entries in the binding scope, most recently modified first by default. `directParentId`
   * limits the result to direct children, never recursive descendants, and throws when the folder
   * is outside the immutable binding scope.
   */
  list(options?: DriveListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search with structured values. At least one filter other than `order` is required. Populated filter
   * fields are AND-ed, while values within `mimeTypes` are OR-ed. `order` cannot be combined with
   * `fullTextContains`; omitting it for full-text search preserves Drive's relevance order.
   *
   * Throws on a file-scoped binding; a single file cannot be searched. Use `getEntry()` to read it.
   * Also throws when no entries match because an owner-relative negative result cannot be shared safely.
   */
  search(query: DriveSearchQuery): Promise<Cursor<DriveEntry>>;

  /**
   * Return metadata for one file ID.
   *
   * A file binding throws without contacting Drive when the ID is not the bound file. A shared-drive
   * binding throws when the file is not in that drive. An account binding returns any file the
   * connected account can read, including files in shared drives it is a member of.
   *
   * Unlike `list()` and `search()`, this can return a trashed file: those methods always exclude
   * trash, while a direct get does not, and {@link DriveEntry} has no `trashed` field.
   */
  getEntry(fileId: string): Promise<DriveEntry>;

  /**
   * Open an in-scope native Google Doc with MIME type
   * `application/vnd.google-apps.document`. Other MIME types, including folders and shortcuts, are
   * rejected. The returned RPC capability supports promise pipelining and must be disposed when
   * finished.
   */
  openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>;

  /**
   * Open an in-scope native Google Sheet with MIME type
   * `application/vnd.google-apps.spreadsheet`. Other MIME types, including folders and shortcuts,
   * are rejected. The returned RPC capability supports promise pipelining and must be disposed when
   * finished.
   */
  openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>;
}

/** The access provided by an account or shared-drive binding. */
export type GoogleDriveSession = GoogleDriveReadSession;
