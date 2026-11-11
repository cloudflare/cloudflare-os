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

/**
 * What a Google Drive binding may do: `"read"` for a read-only binding, which changes nothing, or
 * `"write"` for one connected with read and write access.
 */
export type DriveBindingAccess = "read" | "write";

/**
 * The immutable resource scope of a Google Drive binding or positioned folder capability, with the
 * access the binding was connected with.
 */
export type DriveScope =
  | { kind: "account"; access: DriveBindingAccess }
  | {
    kind: "folder";
    folderId: string;
    rootFolderId: string;
    name: string;
    access: DriveBindingAccess;
  }
  | { kind: "file"; fileId: string; name: string; access: DriveBindingAccess };

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

/** Which bytes of a Drive file `readFile()` reads. */
export type DriveFileReadOptions = {
  /** Where to start, in bytes from the start of the file. Defaults to 0. */
  offset?: number;
  /** How many bytes to read, at least 1. Defaults to the rest of the file. */
  length?: number;
};

/** A Drive file's content, or one range of it, streamed. */
export type DriveFileBytes = {
  /** The file's MIME type, as `DriveEntry.mimeType` gives it. */
  mimeType: string;
  /** The whole file's size in bytes. */
  size: number;
  /** When the file was last modified. Reads reporting different times read different versions of it. */
  modifiedTime: Date;
  /** Where `content` starts, in bytes from the start of the file. */
  offset: number;
  /** How many bytes `content` carries: those asked for, fewer where the file ends, and none from its end. */
  length: number;
  /**
   * The bytes, read from Google as you read them, so a file of any size never has to be held in
   * memory. Pass it to a worktree's `writeBytes()` to save the file, read it whole with
   * `await new Response(content).arrayBuffer()` (or `.text()`, for UTF-8 text), or use a reader
   * to stop early. A range can end partway through a multi-byte character, so decode text read in
   * several ranges with one `TextDecoder`, calling `decoder.decode(bytes, { stream: true })` for
   * each range and `decoder.decode()` at the end; decoding each range on its own corrupts the
   * characters split between them.
   * Read it straight away, and cancel it if you will not: a stream left unread for a minute is
   * ended. A stream that fails partway, whatever its error says, did not deliver the file: it was
   * left unread, or Google stopped sending it or sent less of it than the file had, so read the
   * file again.
   */
  content: ReadableStream<Uint8Array>;
};

/** Who wrote a comment or reply. */
export type DriveCommentAuthor = {
  /**
   * Their display name, as Drive shows it to the connected account, or `You` on an item that is
   * still `pending`. Tell the connected account's items by `me`, not by name.
   */
  displayName: string;
  /** Whether it was the connected account. */
  me: boolean;
};

/** One reply to a Drive comment. */
export type DriveCommentReply = {
  /**
   * Drive's reply ID, or `pending:<n>` while the reply waits for approval. A pending ID names
   * nothing once the reply is decided: list the comments again for the reply as Drive has it.
   */
  id: string;
  author: DriveCommentAuthor;
  /** The reply as plain text. Empty for a resolve without text. */
  text: string;
  /** Time the reply was made or, while it is `pending`, queued. */
  createdTime: Date;
  /** Time the reply was last modified. */
  modifiedTime?: Date;
  /** Present when this reply resolved or reopened its comment. */
  action?: "resolve" | "reopen";
  /** Queued for approval and not yet on Drive. */
  pending?: true;
};

/** One Drive comment and its replies. */
export type DriveComment = {
  /**
   * Drive's comment ID, or `pending:<n>` while the comment waits for approval. A pending ID cannot
   * be replied to or resolved, and names nothing once the comment is decided: list the comments
   * again for its Drive ID.
   */
  id: string;
  author: DriveCommentAuthor;
  /** The comment as plain text. */
  text: string;
  /**
   * The text of the file this comment is attached to, when Drive reports one: a comment made in an
   * editor on a selection, or one that quoted a Google Doc, which shows it while `pending` too.
   * Absent for a comment not attached to text.
   */
  quotedText?: string;
  /** Time the comment was made or, while it is `pending`, queued. */
  createdTime: Date;
  /** Time the comment was last modified. A reply counts as a modification. */
  modifiedTime?: Date;
  /**
   * Whether the comment is resolved, as Drive has it. A resolve or a reopening reply that still
   * awaits approval does not change it: that shows only in `replies`, as a `pending` reply with
   * that `action`.
   */
  resolved: boolean;
  /** As Drive lists them, then this binding's pending ones. */
  replies: DriveCommentReply[];
  /** Queued for approval and not yet on Drive. */
  pending?: true;
};

/**
 * Read-only Google Drive access for an account or exact-file binding: metadata discovery, native
 * Google Docs/Sheets/Slides content, PDF text, the bytes of any other file, and comments.
 *
 * A read-only binding changes nothing. Commenting takes a binding with read and write access,
 * which the user chooses when connecting: request one with `?access=write` added to the resource
 * URL, the narrowest that covers the files to comment on:
 * `https://drive.google.com/file/d/<fileId>/view?access=write` for one file,
 * `https://drive.google.com/drive/folders/<folderId>?access=write` for a folder, or
 * `https://drive.google.com/drive/my-drive?access=write` for all of Drive.
 */
export interface GoogleDriveReadSession {
  /**
   * Return this capability's immutable scope with current display metadata. Its `access` says
   * whether the binding is read-only, which code that may be given either kind of binding checks
   * before it calls a write method.
   */
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
   * Exact-file bindings cannot be searched.
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
   * Read an in-scope file's own content as a stream of bytes: a CSV, image, PDF, Office or any
   * other uploaded file, whatever its type or size. `options` selects part of it; omitted, the
   * whole file. Google Docs, Sheets and Slides are refused naming the method that opens them, as
   * are folders, shortcuts and other Google-native files (MIME types starting
   * `application/vnd.google-apps.`), which have no content to download. Fails when Google does not
   * let the account download the file, and asks to reconnect when the account was connected before
   * Drive bindings could read file content.
   */
  readFile(fileId: string, options?: DriveFileReadOptions): Promise<DriveFileBytes>;

  /**
   * List an in-scope file's comments, each with its replies. Fails for a file the connected
   * account can only view and not comment on: Google shows a file's comments only to accounts
   * that can comment on it. The cursor's `next()` fails asking to reconnect when the Google
   * account was connected before Drive bindings could read file content. A binding with read and
   * write access also lists its own comments and replies that still await approval, marked
   * `pending`. One whose approval Drive did not confirm may already be posted: it is then listed
   * twice, as Drive has it and as the `pending` item, until it is approved again or rejected.
   */
  listComments(fileId: string): Promise<Cursor<DriveComment>>;
}

/**
 * Read-only navigation within the originally selected folder, with its direct children's content
 * and comments. Commenting takes a binding with read and write access, requested as
 * {@link GoogleDriveReadSession} describes.
 */
export interface GoogleDriveFolderReadSession extends Pick<GoogleDriveReadSession, "getScope"> {
  /** List only the positioned folder's direct children. */
  list(options?: DriveFolderListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search the positioned folder's direct children, or those of the folders named by
   * `childFolderIds`, using provider-side filters. At least one filter other than `order` is
   * required, and omitting `order` for a full-text search preserves Drive's relevance order.
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
   * Read a live direct child's own content as a stream of bytes, as
   * `GoogleDriveReadSession.readFile()` does.
   */
  readFile(fileId: string, options?: DriveFileReadOptions): Promise<DriveFileBytes>;

  /**
   * List a live direct child's comments, as {@link GoogleDriveReadSession.listComments} does. A
   * file moved out of this folder ends the listing.
   */
  listComments(fileId: string): Promise<Cursor<DriveComment>>;

  /** Open a live direct child folder as an independently disposable capability. */
  openFolder(folderId: string): Promise<GoogleDriveFolderReadSession>;
}
