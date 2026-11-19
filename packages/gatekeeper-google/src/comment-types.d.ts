/*
 * Comments and suggested edits as every Google binding that has them shows them: a Google Drive
 * binding for any file it reaches, and a directly bound Google Doc for itself. Google Docs and
 * Drive list one comment under one ID, so the same shapes serve both.
 */

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
 * A suggested edit in a native Google Doc, queued for the user's approval. Once approved it is a
 * suggestion in the Doc, which someone who can edit the Doc accepts or rejects there; it is not a
 * comment, so `listComments()` shows it neither while it is queued nor after.
 */
export type DocSuggestion = {
  /** `pending:<n>` while it awaits approval. */
  id: string;
  /** The tab `oldText` is in. */
  tabId: string;
  /** The text the suggestion replaces, trimmed. */
  oldText: string;
  /** What it puts in its place; empty when it deletes `oldText`. */
  newText: string;
  /** Posted as a reply on the suggestion once it is made. */
  note?: string;
  createdTime: Date;
  pending: true;
};
