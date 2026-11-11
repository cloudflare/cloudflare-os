import type {
  DriveComment, DriveCommentReply, GoogleDriveFolderReadSession, GoogleDriveReadSession,
} from "./drive-read-types";
export type * from "./drive-read-types";

/** Options for {@link DriveCommentWrites.comment}. */
export type DriveCommentOptions = {
  /**
   * Text of the file this comment is about, within one paragraph and at most 500 characters, which
   * must occur exactly once in the tab: the tab's text as `getContent()` shows it, without Markdown
   * formatting (no `**`, list markers or escapes) and, in a table, without HTML (`&` rather than
   * `&amp;`, no tags). It is shown in quotes at the top of the comment, with a link to the nearest
   * heading above it when a heading precedes it. Google Docs only.
   */
  quote?: string;
  /** The Doc tab `quote` is in. Defaults to the first tab. */
  tabId?: string;
};

/** Options for {@link DriveCommentWrites.suggestEdit}. */
export type DriveSuggestEditOptions = {
  /** Why, added below the suggestion. */
  note?: string;
  /** The Doc tab `oldText` is in. Defaults to the first tab. */
  tabId?: string;
};

/**
 * Comment writes, which every Google Drive binding with read and write access offers.
 *
 * Comments are plain text, never anchored to text in the file. Each write is queued for the
 * user's approval and returns the pending item, which `listComments()` shows until it is decided.
 * A write needs the connected account to be able to comment on the file, and a new comment makes
 * Google email the file's owner. An email address written after `@` or `+` in the text mentions
 * that person: Google emails them the text, whether or not they can open the file. `fileId` names
 * an in-scope file, as it does for `listComments()`, and not a folder, which takes no comments. A
 * comment or reply holds at most 4096 bytes
 * of UTF-8, counting what `quote` or `suggestEdit()` adds to it. A write also fails, saying what
 * to ask the user for, when the Google account does not allow changes to Drive files, and on a
 * read-only binding, whose `getScope()` reports `access: "read"`.
 */
export interface DriveCommentWrites {
  /** Queue a plain-text comment on an in-scope file. `quote` works only on native Google Docs. */
  comment(fileId: string, text: string, options?: DriveCommentOptions): Promise<DriveComment>;

  /**
   * Queue a comment suggesting `oldText`, which must occur exactly once in the tab (matched and
   * limited as `quote` is), be replaced with `newText` (empty to delete it). The suggestion is a
   * comment, not an edit the owner can accept. Native Google Docs only.
   */
  suggestEdit(
    fileId: string, oldText: string, newText: string, options?: DriveSuggestEditOptions,
  ): Promise<DriveComment>;

  /**
   * Queue a reply to a comment on an in-scope file. Replying to a resolved comment reopens it. A
   * comment that is itself still `pending` takes replies once it is posted, under its Drive ID.
   * Fails for a comment that has a resolve awaiting approval, which the reply would reopen. A
   * closing reply is `resolve()`'s own text, given when the resolve is queued: to add one to a
   * resolve already queued, have the user reject that resolve, then resolve again with the text.
   * Any other reply waits until the resolve is decided. At approval the reply fails if the comment
   * was edited after the reply was queued.
   */
  reply(fileId: string, commentId: string, text: string): Promise<DriveCommentReply>;

  /**
   * Queue resolving a comment on an in-scope file, with an optional closing reply. Fails for a
   * comment that is already resolved, that already has a resolve awaiting approval, or that is
   * itself still `pending`. At approval the resolve fails if the comment was edited after the
   * resolve was queued.
   */
  resolve(fileId: string, commentId: string, text?: string): Promise<DriveCommentReply>;
}

/**
 * An account binding with read and write access: everything {@link GoogleDriveReadSession} reads,
 * anywhere the connected account can reach in Google Drive, plus comment writes.
 */
export interface GoogleDriveSession extends GoogleDriveReadSession, DriveCommentWrites {}

/**
 * An exact-file binding with read and write access: everything {@link GoogleDriveReadSession}
 * reads of its one Drive file, the only file its methods accept, plus comment writes on it.
 */
export interface GoogleDriveFileSession extends GoogleDriveReadSession, DriveCommentWrites {}

/**
 * A folder binding with read and write access: navigation within the originally selected folder as
 * {@link GoogleDriveFolderReadSession} offers it, plus comment writes on the positioned folder's
 * direct children.
 */
export interface GoogleDriveFolderSession extends GoogleDriveFolderReadSession, DriveCommentWrites {
  /**
   * Open a live direct child folder as an independently disposable capability, with the same
   * access.
   */
  openFolder(folderId: string): Promise<GoogleDriveFolderSession>;
}
