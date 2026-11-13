import type { DriveComment } from "./comment-types";
import type { GoogleDocReadSession } from "./docs-read-types";
import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";
import type { GooglePresentationReadSession } from "./slides-read-types";
export type * from "./comment-types";

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
 * `"write"` for one with read and write access. A binding connected with read and write access is
 * read-only while its deployment keeps Google Drive read-only.
 */
export type DriveBindingAccess = "read" | "write";

/**
 * The immutable resource scope of a Google Drive binding or positioned folder capability, with the
 * access the binding has.
 */
export type DriveScope =
  | { kind: "account"; access: DriveBindingAccess }
  | {
    kind: "folder";
    folderId: string;
    rootFolderId: string;
    /**
     * The folder this one was opened from. Absent for the connected folder itself, which nothing
     * in this binding lies above.
     */
    parentFolderId?: string;
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
  /**
   * Direct parent ID: the folder the entry is in, which for an entry at the top level of My Drive
   * is My Drive's own root folder. Absent for a root folder itself, and for an entry in no folder
   * the connected account can see.
   */
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
   * headings, and pages before the first with text left out, unless pages without text are read
   * into it (see `readPdf()`). Read it with `await new Response(text).text()`, or a reader to
   * stop early; cancel it if unread. Empty when `hasText` is false and `transcribed` is too. A
   * failure partway through errors the stream.
   *
   * A page without text of its own is read by a vision model (every page of a scan, and such
   * pages of a PDF that has text), and only once you read the text, then ahead of you: up to
   * 16 pages that are drawn, and up to 4 of a scan read as the file stores it. They may be
   * begun as soon as the text is returned. The model's calls are billed, for a page begun
   * ahead of you also when you never read it:
   * four for most pages that are drawn and up to eight for a closely written one, more when a
   * part of it is asked for again, and one for a page read as the file stores it. So stop reading, and cancel, to stop paying for pages you
   * do not need. Read the text straight away and without long pauses: one whose reading may
   * read the file again is ended with an error after a minute with nothing moving, because it
   * was left unread or the model stopped answering. It also errors when the file has changed
   * since `readPdf()` read it, as its pages are read from Drive again while the text is; when
   * the model fails on a page of a scanned PDF; and when a scanned PDF's pages have to be drawn
   * and cannot be: at all, as for a file that does not open or has more than 2,000 pages, or
   * just now. A text that errors did not give the whole PDF, whatever its error says: read the
   * PDF again, a minute later when it had given nothing.
   *
   * Each line quoted here is a note on its page, not the document's text. A page the model
   * read may end with "[The transcription of this page was cut off.]" or "[This page was read
   * from a drawing at half the usual resolution, which is what its size allowed, so its text may
   * be less exact.]". A page of a scanned PDF may have for its text "[This page could not be
   * drawn within the memory and work a page is allowed, so it was not read.]" or "[This page
   * came out blank: it has nothing on it, or its image could not be read.]"; a page with nothing
   * on it has its heading alone. In a PDF with text of its own, what the model read of a page
   * comes under "[This page has no text of its own: what follows was read from its image by a
   * vision model, which can misread.]", and "[Pages of this PDF that have no text of their own
   * could not be read just now.]" stands for the first page that could not be read: neither it
   * nor the pages without text after it were, and the rest of the text is whole.
   */
  text: ReadableStream<Uint8Array>;
  /** False for a scanned or image-only PDF, which has no text layer. */
  hasText: boolean;
  /**
   * True when `text` is a vision model's reading of the page images of a PDF with no text of its
   * own. It is not the document's own text: the model can misread, most often small print and
   * the codes, numbers and names in it, so check anything that matters against the file. False
   * for a PDF that has text, also when the model read the pages of it that have none: the text
   * says which.
   */
  transcribed: boolean;
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

/**
 * Read-only Google Drive access for an account or exact-file binding: metadata discovery, native
 * Google Docs/Sheets/Slides content, PDF text, the bytes of any other file, and comments.
 *
 * A read-only binding changes nothing. Commenting on files, seeing or changing who they are shared
 * with, and moving them take a binding with read and write access, which the user chooses when
 * connecting: request one with `?access=write` added to the resource URL, the narrowest that covers
 * the files to change: `https://drive.google.com/file/d/<fileId>/view?access=write` for one file
 * (which can be commented on and shared, not moved),
 * `https://drive.google.com/drive/folders/<folderId>?access=write` for a folder, or
 * `https://drive.google.com/drive/my-drive?access=write` for all of Drive. A folder binding moves a
 * file only within that folder, one level per move: into a child folder, or back up to the folder
 * above. So to move a file, request a folder that holds both where the file is and where it goes,
 * or all of Drive. Where the deployment keeps Google Drive read-only, no binding has read and write
 * access, whatever was requested, and a write fails saying so.
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
   *
   * A scanned PDF has no text of its own, so a vision model transcribes its pages as `text` is
   * read: `hasText` is false and `transcribed` true (see `DrivePdfText.transcribed`). Where the
   * deployment has turned that off, a scanned PDF comes back with both false and an empty
   * `text`, and a PDF that has text as that text alone. An encrypted PDF fails.
   *
   * A PDF without text of up to 16 MiB has its pages drawn, so it is read however its images
   * are stored: as fax, JBIG2 or JPEG 2000, with a palette or in CMYK, in layers, tiles or
   * strips, or turned, and so is writing that is drawn as shapes and not kept as text.
   * Each page is drawn in grey, at 150 dpi or fewer for a large one, and cut across where the
   * least is written into up to four bands, and a band of more than 14 lines once more, up to
   * eight in all. Each band with anything on it is one model call,
   * and up to two more when that call failed or its answer was cut off, kept repeating itself
   * or is short for what the band holds. The bands' texts follow one another under the page's
   * heading, so a table or a paragraph that a cut falls in comes back in two parts. Pages are
   * numbered as the document orders them.
   *
   * A larger scan is read as the file stores it, and so is a smaller one whose pages cannot be
   * drawn when `text` is first read, where it can be. Every image at least 200 pixels on each
   * side that is not a mask is read as one page, in one model call, numbered in the order the
   * file stores them, which is page order for a scanner's output; a page stored as several
   * images comes back as several pages, less any piece smaller than that. Pages stored as JPEG
   * are read so, and losslessly compressed (Flate) ones in plain grey or RGB. A larger PDF that
   * holds no image comes back empty with `transcribed` false. For a larger scan `readPdf()`
   * fails, before transcribing anything, for a page, or a mask the size of one
   * (where a scan stored in layers keeps its text), stored as fax or JBIG2; for a page stored
   * as JPEG 2000 or as any other kind of image, such as one with a palette or in CMYK; for a
   * page image that is over 12 MiB as stored, that would have to be uncompressed to over 128
   * MiB, or that is not where the file says it is; for more than 2,000 page images; for
   * images that are all too small to be pages, or masks; and when an edit to the file replaced
   * an image that had a mask.
   *
   * A PDF that has text is returned as that text. One of up to 16 MiB also has each page
   * without text drawn before `text` is read up to it, and a page that shows anything read by
   * the model as a scan's page is, into the text under its heading (see `DrivePdfText.text`).
   * `hasText` is still true and `transcribed` false, the text keeps every page's heading from
   * the first, and a page that cannot be read does not fail it.
   *
   * Where pages cannot be drawn at all, every scan is read as a larger one is, and a PDF that
   * has text is returned as that text alone.
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
 * and comments. Commenting, sharing and moving take a binding with read and write access,
 * requested as {@link GoogleDriveReadSession} describes.
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
   * Read a live direct-child PDF's text, converted to Markdown and streamed, as
   * `GoogleDriveReadSession.readPdf()` does. Fails asking to reconnect when the Google account
   * was connected before Drive bindings could read file content.
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
