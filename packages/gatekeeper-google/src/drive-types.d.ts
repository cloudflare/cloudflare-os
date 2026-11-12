import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";
import type { GoogleDriveFolderReadSession, GoogleDriveReadSession } from "./drive-read-types";
import type { GooglePresentationSession } from "./slides-types";
export type * from "./drive-read-types";

/** Options for {@link DriveCommentWrites.comment}. */
export type DriveCommentOptions = {
  /**
   * Text of the file this comment is about, within one paragraph and at most 500 characters, which
   * must occur exactly once in the tab: the tab's text as `getContent()` shows it, without Markdown
   * formatting (no `**`, list markers or escapes) and, in a table, without HTML (`&` rather than
   * `&amp;`, no tags). The comment is attached to it in the Doc, as one made in the Docs editor
   * is, and must still occur exactly once in the tab when the comment is approved. Google Docs only.
   */
  quote?: string;
  /** The Doc tab `quote` is in. Defaults to the first tab. */
  tabId?: string;
};

/** Options for {@link DriveCommentWrites.suggestEdit}. */
export type DriveSuggestEditOptions = {
  /** Why, posted as a reply on the suggestion; at most 2048 bytes of UTF-8. */
  note?: string;
  /** The Doc tab `oldText` is in. Defaults to the first tab. */
  tabId?: string;
};

/**
 * Comment writes, which every Google Drive binding with read and write access offers.
 *
 * Comments are plain text. One that quotes a Google Doc is attached to the quoted text; any other
 * is attached to no text in the file. Each comment, reply or resolve is queued for the user's
 * approval and returns the pending item, which `listComments()` shows until it is decided.
 * A write needs the connected account to be able to comment on the file, and a new comment makes
 * Google email the file's owner. An email address written after `@` or `+` in the text mentions
 * that person: Google emails them the text, whether or not they can open the file. `fileId` names
 * an in-scope file, as it does for `listComments()`, and not a folder, which takes no comments. A
 * comment or reply holds at most 4096 bytes
 * of UTF-8, and a comment that quotes a Doc at most 2048. A write also fails, saying what
 * to ask the user for, when the Google account does not allow changes to Drive files, and on a
 * read-only binding, whose `getScope()` reports `access: "read"`.
 */
export interface DriveCommentWrites {
  /**
   * Queue a plain-text comment on an in-scope file. `quote` works only on native Google Docs. To
   * propose other text for a passage rather than remark on it, use `suggestEdit()`.
   */
  comment(fileId: string, text: string, options?: DriveCommentOptions): Promise<DriveComment>;

  /**
   * Queue a suggestion that `oldText`, which must occur exactly once in the tab (matched and
   * limited as `quote` is), be replaced with `newText`: empty to delete it, otherwise at most 1000
   * characters without line breaks. Approved, it is a suggestion in the Doc that someone who can
   * edit it accepts or rejects there, as one made in the editor in Suggesting mode; the Doc's text
   * does not change until then. At approval `oldText` must still occur exactly once in the tab.
   * Native Google Docs only. To remark on a passage without proposing a change, use `comment()`
   * with `quote`.
   */
  suggestEdit(
    fileId: string, oldText: string, newText: string, options?: DriveSuggestEditOptions,
  ): Promise<DocSuggestion>;

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

/** A role that can be given: `reader` views, `commenter` also comments, `writer` also edits. */
export type DriveShareRole = "reader" | "commenter" | "writer";

/**
 * A role someone holds, lowest first: `reader`, `commenter`, `writer`, then a shared drive's
 * `fileOrganizer` (content manager) and `organizer` (manager), then `owner`. The last three
 * cannot be given, changed or removed here.
 */
export type DriveRole = DriveShareRole | "fileOrganizer" | "organizer" | "owner";

/**
 * Who a file or folder is shared with. Google decides whether an address is a person's or a
 * group's. One shared as a group's that is a person's is shared with that person. One shared as a
 * person's has to be a person's: if it is a group's, the approved share fails, and the group may
 * have been given the access. So when it is not known which an address is, ask the user before
 * sharing with it.
 */
export type DriveGrantee =
  /** One person, by the email address of their Google account. */
  | { type: "user"; emailAddress: string }
  /** A Google Group, by its address. */
  | { type: "group"; emailAddress: string }
  /** Everyone in a Google Workspace organization, by its domain, such as `example.com`. */
  | { type: "domain"; domain: string }
  /** Anyone who has the link. */
  | { type: "anyone" };

/**
 * Options for {@link DriveSharing.share}. There are no others: access given here does not expire,
 * and ownership is never transferred.
 */
export type DriveShareOptions = {
  /**
   * Users and groups only: whether Google emails them about the file. Defaults to true. An address
   * that has no Google account can be shared with only when it is emailed.
   */
  notify?: boolean;
  /**
   * Users and groups only, and only with `notify`: plain text added to Google's email, at most
   * 1000 characters.
   */
  message?: string;
  /**
   * Domains and anyone only: whether the file can be found by searching, rather than only opened
   * from its link. Defaults to false. It is set when the access is given, and `updateAccess()`
   * changes a role only: to change it, remove the access and, once that is approved, give it again.
   */
  discoverable?: boolean;
};

/** One way someone has access to a Drive file or folder. */
export type DriveAccess = {
  /**
   * Drive's ID for this grantee's access to the file, which `updateAccess()` and `unshare()` take,
   * or `pending:<n>` for access this binding is still waiting to give. A grantee listed more than
   * once, as with access from a parent and access given on the file itself, has the same ID in
   * every entry Drive lists; access still waiting to be given has its own `pending:` ID. A pending
   * ID names nothing once that access is decided: list the access again for its Drive ID.
   */
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  /** The role this entry gives. Of several entries for one grantee, the highest counts. */
  role: DriveRole;
  /** Users and groups: their address, when Drive shows it. */
  emailAddress?: string;
  /** The display name of a user or group, or a domain's organization, when Drive shows it. */
  displayName?: string;
  /** Domains: the domain. */
  domain?: string;
  /** Domains and anyone: whether the file can be found by searching. */
  discoverable?: boolean;
  /**
   * The connected account's own access as a user, which cannot be changed or removed here. Access
   * it has through a group, a domain or a link is not marked.
   */
  me?: true;
  /**
   * This access comes from a parent folder or from the shared drive, not from the file itself. It
   * cannot be changed or removed here: `share()` can still give the grantee a higher role on the
   * file, and the access itself is changed on the folder it comes from. To find that folder, list
   * the access of the folders above the file in turn, as far as this binding reaches: it is the
   * first where the grantee's entry is not `inherited`.
   */
  inherited?: true;
  /**
   * Inherited access: the ID of the folder or shared drive it comes from, which Drive gives only
   * for items in a shared drive.
   */
  inheritedFrom?: string;
  /** Awaiting approval and not yet on Drive: access being given, or a role being changed. */
  pending?: true;
};

/**
 * Sharing: who has access to a file or folder, which every Google Drive binding with read and
 * write access offers.
 *
 * `fileId` names an in-scope file or folder: on a folder binding, a live direct child of the
 * positioned folder or the positioned folder itself. Only what the connected account can share has
 * its sharing read or changed here; anything else fails. A shared drive itself is neither listed
 * nor shared here: who belongs to it is managed in Drive, and its members show as `inherited`
 * access on anything in it. Each change is queued for the user's approval, and `listAccess()`
 * shows it until it is decided. A change still awaiting approval cannot be changed or removed from
 * here: to withdraw it, have the user reject it. The organization's sharing rules still apply, so
 * an approved change can still fail: sharing outside the organization, or with anyone who has the
 * link, may not be allowed. A call also fails, saying what to ask the user for, when the Google
 * account does not allow changes to Drive files, and on a read-only binding, whose `getScope()`
 * reports `access: "read"`.
 */
export interface DriveSharing {
  /**
   * List who has access to an in-scope file or folder, one entry per way they have it: a grantee
   * with access from a parent folder and access given on the file itself is listed twice. This
   * binding's changes still awaiting approval show as if made: access being given and roles being
   * changed are marked `pending`, and access being removed is left out. A change awaiting approval
   * on a folder does not show on what the folder holds, and a move awaiting approval does not
   * change what a file inherits.
   */
  listAccess(fileId: string): Promise<DriveAccess[]>;

  /**
   * Queue giving `grantee` access to an in-scope file or folder as `role`, and return the pending
   * entry. Sharing a folder shares everything in it. Access the grantee already has to something
   * in it, at `role` or lower, is merged into the folder's, and is gone if the folder's access is
   * later removed. Fails for a grantee who already has access given on the file itself, whose role
   * `updateAccess()` changes, for one whose access from a parent already gives `role` or more, for
   * the connected account itself, and for a grantee whose access has a change or removal awaiting
   * approval.
   */
  share(
    fileId: string, grantee: DriveGrantee, role: DriveShareRole, options?: DriveShareOptions,
  ): Promise<DriveAccess>;

  /**
   * Queue changing the role of access given on the file itself, and return the entry as it will
   * be. `access` names it: the `id` `listAccess()` returned, or the grantee who has it, where an
   * address names the access whether it is given as a user's or as a group's. Fails for an owner,
   * for a shared drive's managers and content managers, for the connected account's own access as
   * a user, for access that comes only from a parent (see {@link DriveAccess.inherited}), for a
   * role at or below what a parent already gives, for an entry that is still `pending`, and for
   * one that already has a change awaiting approval. A role raised on a folder merges access to
   * what the folder holds as `share()` does.
   */
  updateAccess(
    fileId: string, access: string | DriveGrantee, role: DriveShareRole,
  ): Promise<DriveAccess>;

  /**
   * Queue removing access given on the file itself, named as for `updateAccess()`. Fails for the
   * access `updateAccess()` fails for: an owner's, a shared drive's managers' and content
   * managers', the connected account's own as a user, access that comes only from a parent, an
   * entry that is still `pending`, and one that already has a change awaiting approval. Access
   * the grantee also has from a parent stays.
   */
  unshare(fileId: string, access: string | DriveGrantee): Promise<void>;
}

/**
 * An account binding with read and write access: everything {@link GoogleDriveReadSession} reads,
 * anywhere the connected account can reach in Google Drive, plus edits of Google Slides
 * presentations, comment writes, sharing and moves.
 */
export interface GoogleDriveSession
    extends GoogleDriveReadSession, DriveCommentWrites, DriveSharing {
  /**
   * Open an in-scope native Google Slides presentation as an independently disposable capability
   * that reads it and queues changes to it, each for the user's approval, as one connected on its
   * own does.
   */
  openGoogleSlides(fileId: string): Promise<GooglePresentationSession>;

  /**
   * Queue moving a file or folder into folder `folderId`, out of the folder it is in. Both must be
   * in the same drive: one shared drive, or neither in a shared drive. Something in the trash, or
   * in no folder the connected account can see, cannot be moved. As `folderId`, `root` names the
   * top level of My Drive; no other call takes it. The top level of a shared drive is a folder
   * too, whose ID is the drive's: the `driveId` of anything in it.
   *
   * Moving changes who has access: the file takes the sharing of its new folder, so everyone with
   * access to that folder gains access to it and access it had only through its old folder is lost.
   * Access given on the file itself that the new folder also gives does not come back if the file
   * later leaves that folder.
   *
   * The move is made once the user approves it. Until then every read shows the file where it is,
   * and a second move of the same file fails. No read tells a move that still waits from one the
   * user rejected: either way the file is where it was.
   */
  move(fileId: string, folderId: string): Promise<void>;
}

/**
 * An exact-file binding with read and write access: everything {@link GoogleDriveReadSession}
 * reads of its one Drive file, the only file its methods accept, plus edits when it is a Google
 * Slides presentation, comment writes and sharing on it. It cannot move the file.
 */
export interface GoogleDriveFileSession
    extends GoogleDriveReadSession, DriveCommentWrites, DriveSharing {
  /**
   * Open an in-scope native Google Slides presentation as an independently disposable capability
   * that reads it and queues changes to it, each for the user's approval, as one connected on its
   * own does.
   */
  openGoogleSlides(fileId: string): Promise<GooglePresentationSession>;
}

/**
 * A folder binding with read and write access: navigation within the originally selected folder as
 * {@link GoogleDriveFolderReadSession} offers it, plus edits of the Google Slides presentations
 * among the positioned folder's direct children, comment writes on those children, sharing of them
 * and of the positioned folder itself, and moves within the originally selected folder.
 */
export interface GoogleDriveFolderSession
    extends GoogleDriveFolderReadSession, DriveCommentWrites, DriveSharing {
  /**
   * Open a live direct-child native Google Slides presentation as an independently disposable
   * capability that reads it and queues changes to it, each for the user's approval, as one
   * connected on its own does.
   */
  openGoogleSlides(fileId: string): Promise<GooglePresentationSession>;

  /**
   * Open a live direct child folder as an independently disposable capability, with the same
   * access.
   */
  openFolder(folderId: string): Promise<GoogleDriveFolderSession>;

  /**
   * Queue moving a live direct child of the positioned folder into `folderId`, which is either a
   * live direct child folder of the positioned folder or `getScope().parentFolderId`, the folder
   * this one was opened from. Nothing moves above the originally selected folder, or into it from
   * outside.
   *
   * While the move awaits approval, a comment, a sharing change or another move is refused for the
   * same file and, when it is a folder, for anything inside it and for a move into it, since each
   * would be approved for a place the file has left: queue those before the move, or, once it is
   * decided, from the folder the file is then in. One queued before the move fails if the move is
   * approved ahead of it. Once a folder has moved, a session opened at it no longer reaches it:
   * open the folder again from where it now is.
   *
   * Otherwise as {@link GoogleDriveSession.move}, except that `root` names nothing here.
   */
  move(fileId: string, folderId: string): Promise<void>;
}
