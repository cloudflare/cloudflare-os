import type { GoogleDocReadSession } from "./docs-read-types";
import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";
import type { GooglePresentationReadSession } from "./slides-read-types";

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

/**
 * Read-only metadata for one entry within the immutable binding scope.
 *
 * `list()` and `search()` never return trashed items, including the bound file of an exact-file
 * binding. `getEntry()` can, and this type does not say whether an entry is trashed — there is no
 * `trashed` field.
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
export type DriveFolderSearchQuery = Omit<DriveSearchQuery, "directParentId"> & {
  /**
   * Search inside these direct child folders instead of the positioned folder. Each must be a
   * listable direct child, and one request covers them all, so polling many sibling folders does
   * not cost a request each. At most 50 per search; search larger sets in batches.
   *
   * Every named folder is recorded as an observation, so one that later stops being listable
   * fails collaborator admission for the whole set. Open folders individually to keep each
   * folder's disclosure independent.
   */
  childFolderIds?: string[];
};

/**
 * Every field either Drive search shape accepts.
 *
 * One class serves both session interfaces, so this is what the RPC boundary validates; each core
 * refuses the field it does not serve rather than ignoring it.
 */
export type DriveSessionSearchQuery =
  DriveSearchQuery & Pick<DriveFolderSearchQuery, "childFolderIds">;

/** A Drive PDF's text, streamed. */
export type DrivePdfText = {
  /**
   * The PDF's text as UTF-8 Markdown, read as it is converted: pages separated by "### Page N"
   * headings, and pages before the first with text left out. Read it with
   * `await new Response(text).text()`, or a reader to stop early; cancel it if unread. Empty when
   * `hasText` is false. A failure partway through errors the stream.
   */
  text: ReadableStream<Uint8Array>;
  /** False for a scanned or image-only PDF, which has no text layer; it is not OCR'd. */
  hasText: boolean;
};

/** Who wrote a comment or reply. */
export type DriveCommentAuthor = {
  /** Their display name, as Drive shows it to the connected account. */
  name: string;
  /** Whether it was the connected account. */
  me: boolean;
};

/** One reply to a Drive comment. */
export type DriveCommentReply = {
  /** Drive's reply ID, or `pending:<n>` while it waits for approval. */
  id: string;
  author: DriveCommentAuthor;
  /** The reply as plain text. Empty for a resolve without text. */
  text: string;
  /** RFC 3339. */
  createdTime: string;
  /** RFC 3339. */
  modifiedTime?: string;
  /** Present when this reply resolved or reopened its comment. */
  action?: "resolve" | "reopen";
  /** Queued for approval and not yet on Drive. */
  pending?: true;
};

/** One Drive comment and its replies. */
export type DriveComment = {
  /** Drive's comment ID, or `pending:<n>` while it waits for approval. */
  id: string;
  author: DriveCommentAuthor;
  /** The comment as plain text. */
  text: string;
  /** RFC 3339. */
  createdTime: string;
  /** RFC 3339. A reply counts as a modification. */
  modifiedTime?: string;
  resolved: boolean;
  /** As Drive lists them, then this connection's pending ones. */
  replies: DriveCommentReply[];
  /** Queued for approval and not yet on Drive. */
  pending?: true;
};

/** Options for {@link GoogleDriveReadSession.comment}. */
export type DriveCommentOptions = {
  /**
   * Text of the file this comment is about, within one paragraph, which must occur exactly once in
   * it: the tab's text as `getContent()` shows it, without Markdown formatting (no `**`, list markers or escapes) and,
   * in a table, without HTML (`&` rather than `&amp;`, no tags). It is shown in quotes at the top
   * of the comment, with a link to the nearest heading above it. Google Docs only.
   */
  quote?: string;
  /** The Doc tab `quote` is in. Defaults to the first tab. */
  tabId?: string;
};

/** Options for {@link GoogleDriveReadSession.suggestEdit}. */
export type DriveSuggestEditOptions = {
  /** Why, added below the suggestion. */
  note?: string;
  /** The Doc tab `oldText` is in. Defaults to the first tab. */
  tabId?: string;
};

/**
 * Drive metadata discovery, read-only native Google Docs/Sheets/Slides access, PDF text, and
 * comments.
 *
 * Comments are plain text, never anchored to text in the file. Writing one is queued for the
 * user's approval, needs the connection's "Allow commenting" permission and that the user can
 * comment on the file, and makes Google email the file's owner. A write returns the pending item,
 * which `listComments()` shows until it is decided.
 */
export interface GoogleDriveReadSession {
  /** Return this capability's immutable scope with current display metadata. */
  getScope(): Promise<DriveScope>;

  /**
   * List entries in an account binding, or the one exact-file entry unless it is trashed.
   *
   * `directParentId` throws unless it names a folder whose children this account can list.
   */
  list(options?: DriveListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search the connected account with structured values. At least one filter other than `order`
   * is required, and omitting `order` for a full-text search preserves Drive's relevance order.
   * Exact-file bindings cannot be searched. An empty result is withheld because it is
   * owner-relative and cannot be shared safely.
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

  /**
   * Open an in-scope native Google Slides presentation as an independently disposable read
   * capability.
   */
  openGoogleSlides(fileId: string): Promise<GooglePresentationReadSession>;

  /**
   * Read an in-scope PDF's text, converted to Markdown and streamed. Fails asking to reconnect
   * when the Google account was connected before Drive bindings could read file content.
   */
  readPdf(fileId: string): Promise<DrivePdfText>;

  /**
   * List an in-scope file's comments, with this connection's writes still awaiting approval
   * marked `pending`. Only a file the user can comment on has its comments read.
   */
  listComments(fileId: string): Promise<Cursor<DriveComment>>;

  /**
   * Queue a plain-text comment on an in-scope file. `quote` works only on native Google Docs.
   */
  comment(fileId: string, text: string, options?: DriveCommentOptions): Promise<DriveComment>;

  /**
   * Queue a comment suggesting `oldText`, which must occur exactly once (matched as `quote` is),
   * be replaced with `newText` (empty to delete it). The suggestion is a comment, not an edit the
   * owner can accept. Native Google Docs only.
   */
  suggestEdit(
    fileId: string, oldText: string, newText: string, options?: DriveSuggestEditOptions,
  ): Promise<DriveComment>;

  /**
   * Queue a reply to a comment on an in-scope file. Replying to a resolved comment reopens it.
   */
  reply(fileId: string, commentId: string, text: string): Promise<DriveCommentReply>;

  /** Queue resolving a comment on an in-scope file, with an optional closing reply. */
  resolve(fileId: string, commentId: string, text?: string): Promise<DriveCommentReply>;
}

/** Navigation within the originally selected folder, and comments on its direct children. */
export interface GoogleDriveFolderSession extends Pick<GoogleDriveReadSession, "getScope"> {
  /** List only the positioned folder's direct children. */
  list(options?: DriveFolderListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search the positioned folder's direct children, or those of the folders named by
   * `childFolderIds`, using provider-side filters. At least one filter other than `order` is
   * required, and omitting `order` for a full-text search preserves Drive's relevance order. An
   * empty result is withheld because it is owner-relative and cannot be shared safely.
   */
  search(query: DriveFolderSearchQuery): Promise<Cursor<DriveEntry>>;

  /** Return one live direct child. A nested descendant or a trashed entry is rejected. */
  getEntry(fileId: string): Promise<DriveEntry>;

  /** Open a live direct-child native Google Doc as an independently disposable capability. */
  openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>;

  /** Open a live direct-child native Google Sheet as an independently disposable capability. */
  openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetReadSession>;

  /**
   * Open a live direct-child native Google Slides presentation as an independently disposable
   * capability.
   */
  openGoogleSlides(fileId: string): Promise<GooglePresentationReadSession>;

  /**
   * Read a live direct-child PDF's text, converted to Markdown and streamed. Fails asking to
   * reconnect when the Google account was connected before Drive bindings could read file content.
   */
  readPdf(fileId: string): Promise<DrivePdfText>;

  /**
   * List a live direct child's comments, as {@link GoogleDriveReadSession.listComments} does. A
   * file moved out of this folder ends the listing.
   */
  listComments(fileId: string): Promise<Cursor<DriveComment>>;

  /** Queue a comment on a live direct child, as {@link GoogleDriveReadSession.comment} does. */
  comment(fileId: string, text: string, options?: DriveCommentOptions): Promise<DriveComment>;

  /**
   * Queue a suggested edit on a live direct child Google Doc, as
   * {@link GoogleDriveReadSession.suggestEdit} does.
   */
  suggestEdit(
    fileId: string, oldText: string, newText: string, options?: DriveSuggestEditOptions,
  ): Promise<DriveComment>;

  /**
   * Queue a reply to a comment on a live direct child. Replying to a resolved comment reopens it.
   */
  reply(fileId: string, commentId: string, text: string): Promise<DriveCommentReply>;

  /** Queue resolving a comment on a live direct child, with an optional closing reply. */
  resolve(fileId: string, commentId: string, text?: string): Promise<DriveCommentReply>;

  /** Open a live direct child folder as an independently disposable capability. */
  openFolder(folderId: string): Promise<GoogleDriveFolderSession>;
}

/** The established account and exact-file Drive read capability. */
export type GoogleDriveSession = GoogleDriveReadSession;
