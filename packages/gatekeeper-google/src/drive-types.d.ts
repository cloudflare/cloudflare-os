import type { GoogleDocReadSession } from "./docs-read-types";
import type { GoogleSpreadsheetReadSession } from "./sheets-types";

/**
 * A pagination cursor.
 *
 * Call `next()` repeatedly on the same RPC object and dispose it when finished. Drain it until
 * `next()` returns `null`; an empty array means only that this call made no visible progress.
 */
export interface Cursor<T> {
  /** The next batch, `[]` when more work remains, or `null` once exhausted. */
  next(): Promise<T[] | null>;
}

/** The immutable resource scope of a Google Drive binding or positioned folder capability. */
export type DriveScope =
  | { kind: "account" }
  | { kind: "folder"; folderId: string; rootFolderId: string; name: string }
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
  | "modifiedTimeDesc"
  | "modifiedTimeAsc"
  | "nameAsc"
  | "nameDesc";

/** Options for listing entries within an account or exact-file binding. */
export type DriveListOptions = {
  /** Limit an account listing to one folder's direct children. */
  directParentId?: string;
  /** Result order. Defaults to most recently modified first. */
  order?: DriveOrder;
};

/** Structured, AND-combined values for searching Drive metadata. */
export type DriveSearchQuery = {
  /** Match entries whose name starts with this value. */
  namePrefix?: string;
  /** Match entries whose indexed body text, description, or OCR text contains this value. */
  fullTextContains?: string;
  /** Match entries having any one of these MIME types. */
  mimeTypes?: string[];
  /** Match entries modified after this RFC 3339 timestamp. */
  modifiedAfter?: string;
  /** Match entries modified before this RFC 3339 timestamp. */
  modifiedBefore?: string;
  /** Limit account matches to one folder's direct children. */
  directParentId?: string;
  /** Result order. Cannot be combined with `fullTextContains`. */
  order?: DriveOrder;
};

/** Listing options for the positioned folder's direct children. */
export type DriveFolderListOptions = Pick<DriveListOptions, "order">;

/** Provider search filters for the positioned folder's direct children. */
export type DriveFolderSearchQuery = Omit<DriveSearchQuery, "directParentId">;

/** Read-only Drive metadata discovery and native Google Docs/Sheets access. */
export interface GoogleDriveReadSession {
  /** Return this capability's immutable scope with current display metadata. */
  getScope(): Promise<DriveScope>;

  /** List entries in an account binding, or return the one exact-file entry. */
  list(options?: DriveListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search the connected account with structured values. Exact-file bindings cannot be searched.
   * An empty result is withheld because it is owner-relative and cannot be shared safely.
   */
  search(query: DriveSearchQuery): Promise<Cursor<DriveEntry>>;

  /**
   * Return one entry. An account binding accepts any accessible ID; an exact-file binding accepts
   * only its bound ID. Either may return trash.
   */
  getEntry(fileId: string): Promise<DriveEntry>;

  /** Open an in-scope native Google Doc as an independently disposable read capability. */
  openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>;

  /** Open an in-scope native Google Sheet as an independently disposable read capability. */
  openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>;
}

/** Read-only navigation within the originally selected folder. */
export interface GoogleDriveFolderSession extends Pick<GoogleDriveReadSession, "getScope"> {
  /** List only the positioned folder's direct children. */
  list(options?: DriveFolderListOptions): Promise<Cursor<DriveEntry>>;

  /** Search only the positioned folder's direct children using provider-side filters. */
  search(query: DriveFolderSearchQuery): Promise<Cursor<DriveEntry>>;

  /** Return one live direct child. A nested descendant or a trashed entry is rejected. */
  getEntry(fileId: string): Promise<DriveEntry>;

  /** Open a live direct-child native Google Doc as an independently disposable capability. */
  openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>;

  /** Open a live direct-child native Google Sheet as an independently disposable capability. */
  openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>;

  /** Open a live direct child folder as an independently disposable capability. */
  openFolder(folderId: string): Promise<GoogleDriveFolderSession>;
}

/** The established account and exact-file Drive read capability. */
export type GoogleDriveSession = GoogleDriveReadSession;
