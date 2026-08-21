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
 * Account scope covers My Drive and items shared directly with the connected account
 * (`corpora=user`). Shared-drive scope means a Google Workspace shared drive, not an ordinary or
 * shared folder; its files belong to the organization rather than an individual. Names are current
 * display metadata; stable IDs are capability identity.
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

/** Read-only metadata for one entry within the immutable binding scope. */
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
  /** Match entries whose name contains this value. */
  nameContains?: string;
  /** Match entries whose indexed text contains this value. */
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
 * Read-only metadata access to the selected Drive scope.
 *
 * Methods do not return file contents, follow shortcut targets, edit Drive, or open native Google
 * Docs or Sheets sessions.
 */
export interface GoogleDriveSession {
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
   */
  search(query: DriveSearchQuery): Promise<Cursor<DriveEntry>>;

  /** Return metadata for one file ID, or throw when the ID is outside the immutable binding scope. */
  getEntry(fileId: string): Promise<DriveEntry>;
}
