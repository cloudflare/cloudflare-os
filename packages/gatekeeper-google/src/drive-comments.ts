/**
 * Approval-backed Drive comments and Google Doc suggestions: what each write queues, how it is
 * described, how an approved one is posted, and how a session shows the writes still awaiting a
 * decision.
 *
 * A comment that quotes a Google Doc, and a suggested edit, go through the Docs API: the Doc is
 * read again at apply, the quoted text must still occur there exactly once, and the write is sent
 * on the revision that read saw. Drive lists a comment made that way under the same ID, so replies,
 * resolves and every look for a posted comment stay on Drive.
 *
 * Neither API takes an idempotency key for a comment, and an error answer does not prove nothing
 * was posted: Drive applies a write before it checks the response mask. So a send leaves a marker
 * before it goes, and an apply that finds one looks for what that send posted before it sends
 * again. The marker outlives its send until the action is settled, so an apply repeated after a
 * send that did post finds it too. Comments do not depend on one another or on the connection
 * they were queued under; the binding's access level, the account's grant, the binding's scope and
 * the account's permission to comment are checked again at apply.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, defineActions, type ActionSubmitter,
  type JournalEntry, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, codeSpan, type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  commentWriteFailure, DriveApiRequestError, isFileInvisible, isInsufficientScope,
  COMMENT_WRITE_MAX_MS, type DriveApi, type DriveCommentRecord, type DriveReplyRecord,
  type DriveScopeNode,
} from "./drive-api";
import {
  docsFileInvisible, docsLacksScope, docsWriteFailure, docsWriteInvalid, type DocsRange,
  type DocsSuggestionRecord, type GoogleDocsApi, type GoogleDocsDocument,
} from "./docs-api";
import { locateQuote, selectTab } from "./drive-comment-body";
import { isDirectChild, readFolderLocation } from "./drive-folder-scope";
import type { DriveBindingScope } from "./drive-session";
import type {
  DocSuggestion, DriveBindingAccess, DriveComment, DriveCommentReply,
} from "./drive-types";
import { GoogleApiError } from "./google-response";
import { obsContext } from "./observability";
import { driveResourceUrl, type DriveAccessLevel } from "./resources";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.comments", vendorId: "google",
});

/**
 * The one kind every Drive comment write is queued as, so one rule auto-approves them all.
 *
 * Every write of it is auto-approvable: it posts into a file the binding reaches and deletes
 * nothing. Rule 2 of the opt-out policy covers one case, a text that mentions someone, an address
 * written after `@` or `+`: Google emails that person the text, whether or not they can open the
 * file. The verdict is kept `true` there by decision, as a listed exception to the policy. No
 * mention is looked for, and the text is sent as it was written.
 */
const DRIVE_COMMENTS: ActionKind = { tag: "driveComments", label: "Drive comments" };

/** The refusal for a read and write binding whose account does not hold the Drive writes grant. */
export const WRITES_GRANT_MISSING =
  "Changes need a permission this Google account hasn't granted, or no longer grants. In " +
  "Workshop, start adding a Google Drive connection for this account, choose all of Drive or a " +
  "folder, then \"Read and write\", and select \"Allow changes\". The permission covers every " +
  "read and write Drive connection on the account, so the dialog can then be closed.";

/**
 * The refusal for a write on a read-only binding of `scope`. It ends with the URL to request
 * instead and nothing after it, and no URL in it is followed by punctuation: copied with a
 * URL, that would change its last parameter's value, which then reads as read-only. All of
 * Drive is the widest connection there is, so its refusal names the narrower ones first.
 */
export function readOnlyRefusal(scope: DriveBindingScope): string {
  let url = driveResourceUrl(
    scope.kind === "account" ? { kind: "driveAccount", access: "write" }
    : scope.kind === "folder" ? { kind: "driveFolder", folderId: scope.folderId, access: "write" }
    : { kind: "driveFile", fileId: scope.fileId, access: "write" });
  let request = scope.kind === "account"
    ? "To change one file, or the files of one folder, request the narrower " +
      "https://drive.google.com/file/d/<fileId>/view?access=write or " +
      "https://drive.google.com/drive/folders/<folderId>?access=write instead. For all of " +
      "Drive, request this resource URL:"
    : "Request one with this resource URL:";
  return "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
    `connection with read and write access, which the user chooses when connecting. ${request} ${
      url}`;
}

/** What decides whether a binding may make changes. */
export type DriveWriteGate = {
  /** The binding's access level; anything but `"write"` is read-only. */
  access?: DriveAccessLevel;
  /** The binding's own scope, which a read-only refusal names the read and write URL of. */
  scope: DriveBindingScope;
  /**
   * Whether the account holds the Drive writes grant, read live. Rejects when the account itself
   * cannot answer for the binding, as one that was disconnected cannot: no grant would lift that.
   */
  holdsGrant(): Promise<boolean>;
};

/**
 * Why a binding cannot make changes now, or `undefined` when it can: it is read-only, or its
 * account does not hold the Drive writes grant. Asked when a write is queued and again when it
 * is applied. A failure of the grant's read is passed on as it came.
 */
export async function writeRefusal(gate: DriveWriteGate): Promise<string | undefined> {
  if (gate.access !== "write") return readOnlyRefusal(gate.scope);
  return (await gate.holdsGrant()) ? undefined : WRITES_GRANT_MISSING;
}

/** The refusal for a reply to, or a resolve of, a comment that is itself still queued. */
const PENDING_COMMENT_REFUSED =
  "That comment is waiting for approval; reply to it once it is posted.";

/** The refusal for a reply to, or a resolve of, the `pending:` ID of a suggested edit. */
const PENDING_SUGGESTION_REFUSED =
  "That pending ID names a suggested edit, which takes no replies here; once it is approved, " +
  "the Doc's owner answers it in the Doc.";

/** The refusal for a reply to, or a resolve of, a `pending:` ID that names no queued comment. */
const PENDING_COMMENT_DECIDED =
  "That pending ID names no comment waiting for approval. If its comment was posted, list the " +
  "file's comments again and use the comment's Drive ID.";

/** The refusal for a resolve of a comment this binding already has a resolve queued for. */
export const RESOLVE_PENDING =
  "That comment already has a resolve waiting for approval. To give it a closing reply, have " +
  "that resolve rejected and resolve again with the reply as the text.";

/** The refusal for a reply to a comment this binding has a resolve queued for. */
export const REPLY_RESOLVE_PENDING =
  "That comment has a resolve waiting for approval, and a reply posted after it would reopen " +
  "the comment. To close the comment with a reply, have that resolve rejected and resolve " +
  "again with the reply as the text; otherwise reply once the resolve is decided.";

/** The refusal for resolving a resolved comment, which Drive would accept with another reply. */
export const ALREADY_RESOLVED = "That comment is already resolved.";

/** The refusal for a reply to, or a resolve of, a comment Drive does not show. */
export const COMMENT_NOT_FOUND = "That comment was not found on this file.";

const RESOLVED_SINCE_QUEUED = "That comment was resolved after this reply was queued, and " +
  "replying would reopen it. Queue the reply again to reopen it.";
const EDITED_SINCE_QUEUED = "That comment was edited after this was queued. Queue it again to " +
  "answer the comment as it is now.";
const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const CANNOT_COMMENT = "The connected account can no longer comment on that file.";
const QUOTE_GONE = "The quoted text is no longer in the Doc exactly once, so this can't be " +
  "attached to it. Queue it again with text the Doc has now.";
const DOC_CHANGED_WHILE_SENT = "The Google Doc changed while this was being sent, so nothing " +
  "was posted. Approve it again to place it on the Doc as it is now.";

/** The ID a queued write is shown under until it is posted. */
const PENDING_PREFIX = "pending:";

/** Longest excerpt of the comment a reply answers that its approval shows, in characters. */
const PARENT_EXCERPT_CHARS = 200;

/** How far Drive's clock may run behind ours. */
const CLOCK_SKEW_MS = 10_000;
/** How long after a send began Drive may date what it posted: well past the write's own timeout. */
const RECONCILE_WINDOW_MS = Math.max(5 * 60 * 1000, 2 * COMMENT_WRITE_MAX_MS);
/** Most pages one look for a posted comment reads. */
const MAX_RECONCILE_PAGES = 50;

/** Longest part of a file's name its approval shows, in characters. */
const FILE_NAME_CHARS = 200;

/**
 * What a write's approval shows of the file's name: all of it, or its first 200 characters and
 * an ellipsis.
 */
export function shownFileName(name: string): string {
  let characters = [...name];
  return characters.length > FILE_NAME_CHARS
    ? `${characters.slice(0, FILE_NAME_CHARS).join("")}…` : name;
}

/**
 * The comment a reply or resolve answers, as it stood when queued: what the approval shows of it,
 * and what apply holds it to.
 */
export type CommentParent = {
  author: string;
  /** The comment's text, or the first 200 characters of a longer one: what the approval shows. */
  excerpt: string;
  /** The comment's text is longer than `excerpt`, which the approval then says. */
  cut?: true;
  /** Hex SHA-256 of the comment's whole text, which apply requires it still to have. */
  sha256: string;
};

/** What every Drive comment write carries about the file it is on. */
export type CommentTargetPayload = {
  fileId: string;
  /** The file's name when the write was queued, as {@link shownFileName} cuts it, for the approver. */
  fileName?: string;
  /** For a folder binding, the path from the bound root to the file's parent, proven at apply. */
  folderIds?: string[];
  /** RFC 3339, shown as the pending item's creation time. */
  queuedAt: string;
};

/** Each Drive comment write, by the action kind it is queued as. */
export type DriveCommentActions = {
  createComment: CommentTargetPayload & {
    content: string;
    /**
     * The Google Doc text the comment is attached to, found exactly once in tab `tabId` when
     * queued and again at apply, where it is sent through the Docs API anchored to that text.
     */
    anchor?: { tabId: string; text: string };
  };
  createReply: CommentTargetPayload & {
    commentId: string;
    content: string;
    parent: CommentParent;
    /** The comment was resolved when queued, and Drive reopens a resolved comment replied to. */
    reopens?: true;
  };
  resolveComment: CommentTargetPayload & {
    commentId: string;
    /** Absent for a resolve without text, which is sent with no content. */
    content?: string;
    parent: CommentParent;
  };
  /** A suggestion in a Google Doc: `oldText`, found exactly once in tab `tabId`, replaced. */
  suggestEdit: CommentTargetPayload & {
    tabId: string;
    oldText: string;
    /** Empty to delete `oldText`. */
    newText: string;
    /** Posted as a reply on the suggestion once it is made. */
    note?: string;
  };
};

/** One queued Drive comment write. */
export type DriveCommentAction = TaggedAction<DriveCommentActions>;

/** What a Drive session needs of its gatekeeper to show and queue comment writes. */
export type DriveCommentQueue = {
  /** The binding's access, which the session reports with its scope. */
  access: DriveBindingAccess;
  /** Why this binding cannot make changes now, or `undefined` when it can (see {@link writeRefusal}). */
  writeRefusal(): Promise<string | undefined>;
  /** Queues one write for approval through `queue`, returning its action ID. */
  submit<K extends keyof DriveCommentActions>(
    queue: ActionSubmitter, kind: K, payload: DriveCommentActions[K],
  ): Promise<number>;
  /**
   * Runs `read` with the writes awaiting a decision while none is being applied or rejected, so a
   * write Drive posts mid-read is not shown both as posted and as pending.
   */
  undecided<T>(
    read: (pending: readonly JournalEntry<DriveCommentAction>[]) => Promise<T>,
  ): Promise<T>;
};

/** A send that may have reached Drive, recorded before it went. */
export type CommentAttempt = {
  at: number;
  /**
   * The account's replies already on the comment that look like what this send posts, or, for a
   * suggested edit, the account's suggestions already in the Doc.
   */
  existing?: string[];
  /** Earlier sends of this write proven to have posted nothing. */
  failedSends?: number;
  /** A suggested edit's suggestion, once it is known to be made: what remains is its note. */
  suggestionId?: string;
  /** When the note's send began, once one has: a retry looks for it before sending again. */
  noteAt?: number;
};

/** What applying a Drive comment write needs. */
export type DriveCommentsHost = {
  api: Pick<DriveApi,
    "getScopeNodes" | "getComment" | "listComments" | "listReplies" | "createComment" |
    "createReply">;
  /** The Docs API, through which comments that quote a Doc and suggested edits are sent. */
  docs: Pick<GoogleDocsApi,
    "getDocumentWithSuggestions" | "getRevisionId" | "insertComment" | "suggest" |
    "replyToSuggestion">;
  /** The binding's scope, read when an action applies. */
  scope(): DriveBindingScope;
  /** Why this binding cannot make changes now, read when an action applies. */
  writeRefusal(): Promise<string | undefined>;
  /** Each send's marker, by action ID, kept until the write is settled. */
  attempts: {
    get(id: number): CommentAttempt | undefined;
    put(id: number, attempt: CommentAttempt): void;
    delete(id: number): void;
  };
};

/** Whether `id` names a write still queued rather than a comment on Drive. */
export function isPendingCommentId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

/** A comment as Drive shows it, or `undefined` once it is deleted or not found. */
export async function readLiveComment(
  api: Pick<DriveApi, "getComment">, fileId: string, commentId: string,
): Promise<DriveCommentRecord | undefined> {
  try {
    let comment = await api.getComment(fileId, commentId);
    return comment.deleted ? undefined : comment;
  } catch (error) {
    if (error instanceof DriveApiRequestError && error.status === 404) return undefined;
    throw error;
  }
}

/** A hex SHA-256 of `text`. */
async function sha256Hex(text: string): Promise<string> {
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** What a reply or resolve keeps of the comment it answers: see {@link CommentParent}. */
export async function commentParent(comment: DriveCommentRecord): Promise<CommentParent> {
  let characters = [...comment.content];
  return {
    author: comment.author.displayName,
    excerpt: characters.slice(0, PARENT_EXCERPT_CHARS).join(""),
    ...(characters.length > PARENT_EXCERPT_CHARS ? { cut: true as const } : {}),
    sha256: await sha256Hex(comment.content),
  };
}

/**
 * The refusal for a reply to, or a resolve of, the `pending:` ID `commentId`: its comment still
 * awaits approval among `pending`, or the ID names no queued comment, having been decided or
 * never issued for one.
 */
export function pendingCommentRefusal(
  commentId: string, pending: readonly JournalEntry<DriveCommentAction>[],
): string {
  let named = pending.find(({ id }) => `${PENDING_PREFIX}${id}` === commentId)?.action.kind;
  return named === "createComment" ? PENDING_COMMENT_REFUSED
    : named === "suggestEdit" ? PENDING_SUGGESTION_REFUSED : PENDING_COMMENT_DECIDED;
}

/** Whether `pending` holds a resolve of comment `commentId` on file `fileId`. */
export function hasPendingResolve(
  fileId: string, commentId: string, pending: readonly JournalEntry<DriveCommentAction>[],
): boolean {
  return pending.some(({ action }) =>
    action.kind === "resolveComment" && action.payload.fileId === fileId &&
    action.payload.commentId === commentId);
}

/** A time Drive gave a comment or reply, validated. */
function commentTime(value: string): Date {
  let time = new Date(value);
  if (Number.isNaN(time.valueOf())) throw new Error("Google Drive returned an invalid comment time");
  return time;
}

function toReply(reply: DriveReplyRecord): DriveCommentReply {
  return {
    id: reply.id,
    author: { displayName: reply.author.displayName, me: reply.author.me },
    text: reply.content,
    createdTime: commentTime(reply.createdTime),
    ...(reply.modifiedTime === undefined ? {} : { modifiedTime: commentTime(reply.modifiedTime) }),
    ...(reply.action === undefined ? {} : { action: reply.action }),
  };
}

/** Maps one Drive comment to the agent's shape, deleted replies left out. */
export function toDriveComment(comment: DriveCommentRecord): DriveComment {
  return {
    id: comment.id,
    author: { displayName: comment.author.displayName, me: comment.author.me },
    text: comment.content,
    ...(comment.quotedText === undefined ? {} : { quotedText: comment.quotedText }),
    createdTime: commentTime(comment.createdTime),
    ...(comment.modifiedTime === undefined ? {} : { modifiedTime: commentTime(comment.modifiedTime) }),
    resolved: comment.resolved,
    replies: comment.replies.filter(reply => !reply.deleted).map(toReply),
  };
}

const PENDING_AUTHOR = { displayName: "You", me: true };

/** The queued comment `id` will post, as the session shows it. */
export function pendingComment(
  id: number, payload: DriveCommentActions["createComment"],
): DriveComment {
  return {
    id: `${PENDING_PREFIX}${id}`, author: PENDING_AUTHOR, text: payload.content,
    ...(payload.anchor ? { quotedText: payload.anchor.text } : {}),
    createdTime: new Date(payload.queuedAt), resolved: false, replies: [], pending: true,
  };
}

/** The queued suggested edit `id` will make, as the session returns it. */
export function pendingSuggestion(
  id: number, payload: DriveCommentActions["suggestEdit"],
): DocSuggestion {
  let { tabId, oldText, newText, note } = payload;
  return {
    id: `${PENDING_PREFIX}${id}`, tabId, oldText, newText, ...(note === undefined ? {} : { note }),
    createdTime: new Date(payload.queuedAt), pending: true,
  };
}

/** The queued reply or resolve `id` will post, as the session shows it. */
export function pendingReply(
  id: number,
  action: Extract<DriveCommentAction, { kind: "createReply" | "resolveComment" }>,
): DriveCommentReply {
  let { payload } = action;
  let replyAction: DriveCommentReply["action"] = action.kind === "resolveComment" ? "resolve"
    : action.payload.reopens ? "reopen" : undefined;
  return {
    id: `${PENDING_PREFIX}${id}`, author: PENDING_AUTHOR, text: payload.content ?? "",
    createdTime: new Date(payload.queuedAt), ...(replyAction ? { action: replyAction } : {}),
    pending: true,
  };
}

/**
 * One page of `fileId`'s comments with this binding's undecided writes for the file: each queued
 * reply or resolve under the comment it answers, and, on the last page, each queued comment. A
 * queued suggested edit is not shown: Drive lists no suggestion. `quotesDocument` says whether the
 * page shows a queued comment that quotes the file as a Google Doc.
 */
export function overlayPending(
  fileId: string,
  comments: DriveComment[],
  pending: readonly JournalEntry<DriveCommentAction>[],
  last: boolean,
): { comments: DriveComment[]; quotesDocument: boolean } {
  let mine = pending.filter(({ action }) => action.payload.fileId === fileId);
  let shown = comments.map(comment => {
    let replies = mine.flatMap(({ id, action }) =>
      (action.kind === "createReply" || action.kind === "resolveComment") &&
        action.payload.commentId === comment.id ? [pendingReply(id, action)] : []);
    return replies.length ? { ...comment, replies: [...comment.replies, ...replies] } : comment;
  });
  let quotesDocument = false;
  if (last) {
    for (let { id, action } of mine) {
      if (action.kind !== "createComment") continue;
      shown.push(pendingComment(id, action.payload));
      quotesDocument ||= action.payload.anchor !== undefined;
    }
  }
  return { comments: shown, quotesDocument };
}

/**
 * The file as the binding's scope reaches it at apply, with whether this account may comment, or
 * `undefined` when it is out of scope or invisible. A folder binding re-proves every saved link
 * and the file's place under the last, in one batch.
 */
async function scopedFile(
  host: DriveCommentsHost, payload: CommentTargetPayload,
): Promise<DriveScopeNode | undefined> {
  let scope = host.scope();
  if (scope.kind === "file" && payload.fileId !== scope.fileId) return undefined;
  if (scope.kind !== "folder") return (await host.api.getScopeNodes([payload.fileId]))[0];
  let folderIds = payload.folderIds;
  if (!folderIds?.length || folderIds[0] !== scope.folderId) return undefined;
  let nodes = await host.api.getScopeNodes([...folderIds, payload.fileId]);
  let file = nodes.pop();
  // Handed the nodes already read, the location check can only refuse.
  let path = await readFolderLocation({ folderIds }, async () => nodes).catch(() => undefined);
  return file && path && isDirectChild(file, path[path.length - 1]) ? file : undefined;
}

/**
 * Refuses a write that may not be made at apply, having posted nothing: for good, except while the
 * account does not hold the grant, which leaves the write pending for a later approval.
 * @returns The comment a reply or resolve answers, as it stands now.
 */
async function requireStillAllowed(
  host: DriveCommentsHost, action: DriveCommentAction,
): Promise<DriveCommentRecord | undefined> {
  let refused = await host.writeRefusal();
  // Allowing changes again lifts the grant's refusal; a binding's access level never changes.
  if (refused === WRITES_GRANT_MISSING) throw new Error(refused);
  if (refused !== undefined) throw new ActionApplyError(refused);
  let file = await scopedFile(host, action.payload);
  if (!file) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
  if (file.canComment !== true) throw new ActionApplyError(CANNOT_COMMENT);
  if (action.kind === "createComment" || action.kind === "suggestEdit") return undefined;
  let comment = await readLiveComment(host.api, action.payload.fileId, action.payload.commentId);
  if (!comment) throw new ActionApplyError(COMMENT_NOT_FOUND);
  // The approval showed this comment, and the write answers all of it. Only its text is compared:
  // the author never changes, and a changed display name is not a changed comment.
  if (await sha256Hex(comment.content) !== action.payload.parent.sha256) {
    throw new ActionApplyError(EDITED_SINCE_QUEUED);
  }
  if (action.kind === "resolveComment" && comment.resolved) {
    throw new ActionApplyError(ALREADY_RESOLVED);
  }
  // Drive reopens a resolved comment replied to, which this reply's approval did not say.
  if (action.kind === "createReply" && comment.resolved && !action.payload.reopens) {
    throw new ActionApplyError(RESOLVED_SINCE_QUEUED);
  }
  return comment;
}

/** Every item a list read yields, page by page, refusing a token Drive hands back twice. */
async function readAll<T>(
  read: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string | undefined }>,
): Promise<T[]> {
  let items: T[] = [];
  let seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
    let result = await read(pageToken);
    items.push(...result.items);
    pageToken = result.nextPageToken;
    if (pageToken === undefined) return items;
    if (seen.has(pageToken)) throw new Error("Google Drive returned a repeated page token.");
    seen.add(pageToken);
  }
  throw new Error(
    "Google Drive listed more comments than one check reads. Approve it again later.");
}

/** Whether `item` is the connected account's, not deleted, and dated within `from`..`until`. */
function mineFrom(
  item: DriveCommentRecord | DriveReplyRecord, from: number, until = Infinity,
): boolean {
  let created = Date.parse(item.createdTime);
  return item.author.me && !item.deleted && created >= from && created <= until;
}

/** Whether `reply` has the content and action a send of `action` posts. */
function looksSent(
  action: Extract<DriveCommentAction, { kind: "createReply" | "resolveComment" }>,
  reply: DriveReplyRecord,
): boolean {
  return reply.content === (action.payload.content ?? "") &&
    // Drive marks a plain reply to a resolved comment as reopening it.
    (action.kind === "resolveComment" ? reply.action === "resolve" : reply.action !== "resolve");
}

/**
 * Finds what the send `attempt` records posted, so a retry binds it rather than posting twice:
 * the connected account's one comment or reply from around the attempt, with exactly the content
 * sent and, for a resolve, the resolve action. Drive stores a text as sent but for white space at
 * its ends, which a composed body never has.
 * @returns Its ID, or `undefined` when there is none: proof nothing was posted only once the
 * attempt's window has closed.
 * @throws ActionOutcomeUnknownError when more than one matches, or the file or comment is gone.
 * A look Google refuses for a missing scope throws the grant's refusal instead, which is retried.
 */
async function findPosted(
  host: DriveCommentsHost, action: DriveCommentAction, attempt: CommentAttempt,
): Promise<string | undefined> {
  if (action.kind === "suggestEdit") return findSuggestion(host, action.payload, attempt);
  let from = attempt.at - CLOCK_SKEW_MS;
  let until = attempt.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS;
  let around = (item: DriveCommentRecord | DriveReplyRecord) =>
    mineFrom(item, from, until) && !attempt.existing?.includes(item.id);
  let { payload } = action;
  let candidates: (DriveCommentRecord | DriveReplyRecord)[];
  try {
    if (action.kind === "createComment") {
      // Drive lists a comment made through Docs under the same ID, with the content as sent.
      // Inclusive, and a comment is modified no earlier than it was created.
      let startModifiedTime = new Date(from).toISOString();
      candidates = (await readAll(async pageToken => {
        let page = await host.api.listComments(payload.fileId,
          { startModifiedTime, ...(pageToken ? { pageToken } : {}) });
        return { items: page.comments, nextPageToken: page.nextPageToken };
      })).filter(comment => around(comment) && comment.content === action.payload.content);
    } else {
      let { commentId } = action.payload;
      candidates = (await readAll(async pageToken => {
        let page = await host.api.listReplies(payload.fileId, commentId,
          pageToken ? { pageToken } : {});
        return { items: page.replies, nextPageToken: page.nextPageToken };
      })).filter(reply => around(reply) && looksSent(action, reply));
    }
  } catch (error) {
    // A token without the scope cannot look at all. That says nothing of the file, and allowing
    // changes again lifts it, so the write waits with its marker, as after a send refused for it.
    if (isInsufficientScope(error)) throw new Error(WRITES_GRANT_MISSING, { cause: error });
    if (!isFileInvisible(error)) throw error;
    throw new ActionOutcomeUnknownError(
      "Google Drive no longer shows this file or comment to the connected account, so whether " +
      "this was posted can't be checked, and it won't be sent again. Reject it to clear it.",
      { cause: error });
  }
  if (candidates.length > 1) {
    throw new ActionOutcomeUnknownError(
      "The connected account has more than one identical comment from around when this was " +
      "sent, so which of them this posted is unknown, and it won't be sent again. Check the " +
      "file's comments, then reject it to clear it.");
  }
  return candidates[0]?.id;
}

/** What a suggested edit's suggestion sums up as, in Google's words. */
export function suggestionSummary(payload: DriveCommentActions["suggestEdit"]): string {
  return payload.newText === "" ? `Delete: “${payload.oldText}”`
    : `Replace: “${payload.oldText}” with “${payload.newText}”`;
}

/** Whether a Docs post is the connected account's, not deleted, and dated within `from`..`until`. */
function myPostFrom(
  docsPost: DocsSuggestionRecord["headPost"], from: number, until = Infinity,
): boolean {
  let created = Date.parse(docsPost.createTime);
  return docsPost.me && !docsPost.deleted && created >= from && created <= until;
}

/**
 * The Doc as a write is based on it, with its suggestions. A look (`look`) that Google refuses
 * because the file is gone or hidden cannot tell what was posted; a read before a send that it
 * refuses so posted nothing. Either way a missing scope throws the grant's refusal, which is retried.
 */
async function readDoc(
  host: DriveCommentsHost, fileId: string, look: boolean,
): Promise<{ document: GoogleDocsDocument; suggestions: DocsSuggestionRecord[] }> {
  try {
    return await host.docs.getDocumentWithSuggestions(fileId);
  } catch (error) {
    if (docsLacksScope(error)) throw new Error(WRITES_GRANT_MISSING, { cause: error });
    if (!docsFileInvisible(error)) throw error;
    if (!look) {
      throw new ActionApplyError(
        "Google Docs no longer shows this file to the connected account.", { cause: error });
    }
    throw new ActionOutcomeUnknownError(
      "Google Docs no longer shows this file to the connected account, so whether this was " +
      "posted can't be checked, and it won't be sent again. Reject it to clear it.",
      { cause: error });
  }
}

/**
 * Finds the suggestion the send `attempt` records made: the connected account's one suggestion
 * from around the attempt, not in the Doc before it, that Google sums up as this edit.
 * @returns Its ID, or `undefined` when the account made none then.
 * @throws ActionOutcomeUnknownError when the account made suggestions then and none, or more than
 * one, sums up as this edit, so which is this one can't be told.
 */
async function findSuggestion(
  host: DriveCommentsHost, payload: DriveCommentActions["suggestEdit"], attempt: CommentAttempt,
): Promise<string | undefined> {
  let from = attempt.at - CLOCK_SKEW_MS;
  let until = attempt.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS;
  let { suggestions } = await readDoc(host, payload.fileId, true);
  let mine = suggestions.filter(suggestion => myPostFrom(suggestion.headPost, from, until) &&
    !attempt.existing?.includes(suggestion.suggestionId));
  let summary = suggestionSummary(payload);
  let matching = mine.filter(suggestion => suggestion.summaryText === summary);
  if (matching.length === 1) return matching[0].suggestionId;
  if (mine.length) {
    throw new ActionOutcomeUnknownError(
      "The connected account made suggestions in this Doc around when this was sent that can't " +
      "be told apart from it, so whether this was made is unknown, and it won't be sent again. " +
      "Check the Doc's suggestions, then reject it to clear it.");
  }
  return undefined;
}

/** Where a Docs send goes: the range found by the read at apply, and that read's revision. */
type DocsPlacement = {
  range: DocsRange;
  revisionId?: string;
  /** The connected account's suggestions in the Doc at that read. */
  mySuggestions: string[];
};

/**
 * Reads the Doc a comment that quotes it, or a suggested edit, is sent to, and finds the quoted
 * text there, which must still occur exactly once in its tab. `undefined` for a write sent
 * through Drive.
 */
async function place(
  host: DriveCommentsHost, action: DriveCommentAction,
): Promise<DocsPlacement | undefined> {
  let quoted = action.kind === "createComment" ? action.payload.anchor
    : action.kind === "suggestEdit"
      ? { tabId: action.payload.tabId, text: action.payload.oldText } : undefined;
  if (!quoted) return undefined;
  let { document, suggestions } = await readDoc(host, action.payload.fileId, false);
  let range: DocsRange;
  try {
    range = locateQuote(selectTab(document, quoted.tabId), quoted.text);
  } catch (error) {
    throw new ActionApplyError(QUOTE_GONE, { cause: error });
  }
  return {
    range, ...(document.revisionId ? { revisionId: document.revisionId } : {}),
    mySuggestions: suggestions.filter(({ headPost }) => headPost.me)
      .map(({ suggestionId }) => suggestionId),
  };
}

/**
 * Posts a suggested edit's note on its suggestion once it is made, looking first for what an
 * earlier send of the note may have posted. `attempt` is the write's marker, which keeps the
 * suggestion's ID from here on, so a retry never makes the suggestion again.
 */
async function postNote(
  host: DriveCommentsHost, id: number, payload: DriveCommentActions["suggestEdit"],
  suggestionId: string, attempt: CommentAttempt,
): Promise<void> {
  let { note } = payload;
  let marked: CommentAttempt = { ...attempt, suggestionId };
  delete marked.noteAt;
  if (note === undefined) return;
  if (attempt.noteAt !== undefined) {
    let noteAttempt = { at: attempt.noteAt };
    let conclusive = windowClosed(noteAttempt);
    let { suggestions } = await readDoc(host, payload.fileId, true);
    let thread = suggestions.find(suggestion => suggestion.suggestionId === suggestionId);
    if (!thread) {
      throw new ActionOutcomeUnknownError(
        "The suggestion was made, and the Doc no longer shows it, so whether its note was " +
        "posted can't be checked, and it won't be sent again. Reject it to clear it.");
    }
    let from = noteAttempt.at - CLOCK_SKEW_MS;
    if (thread.replies.some(reply => myPostFrom(reply, from) && reply.content === note)) return;
    if (!conclusive) throw notShownYet(noteAttempt);
    await requireSightedLook(host, { kind: "suggestEdit", payload });
  }
  host.attempts.put(id, { ...marked, noteAt: Date.now() });
  try {
    await host.docs.replyToSuggestion(payload.fileId, suggestionId, note);
  } catch (error) {
    let failure = docsWriteFailure(error);
    if (failure === "unknown") {
      throw new Error("The suggestion was made, but Google Docs did not confirm whether its " +
        "note was posted. Approving it again first checks the suggestion, so the note is not " +
        "posted twice.", { cause: error });
    }
    // Nothing was posted: the next approval sends the note again, never the suggestion.
    host.attempts.put(id, marked);
    if (failure === "rateLimited") throw new Error(rateLimited("Google Docs"), { cause: error });
    if (docsLacksScope(error)) throw new Error(WRITES_GRANT_MISSING, { cause: error });
    throw new ActionApplyError("The suggestion was made, but Google Docs refused its note.",
      { cause: error });
  }
}

/** The end of a look that found nothing while Drive shows this account none of the file's comments. */
const LOOK_BLIND = "The connected account can no longer comment on that file, and Google Drive " +
  "shows a file's comments only to accounts that can, so whether this was posted can't be " +
  "checked, and it won't be sent again. Reject it to clear it.";

/**
 * Refuses to take a look that found nothing for proof that nothing was posted, when it could have
 * found nothing either way: Drive lists an account that cannot comment on a file none of its
 * comments, its own included, and answers with no error.
 * @throws ActionOutcomeUnknownError when the connected account cannot comment on the file now.
 */
async function requireSightedLook(host: DriveCommentsHost, action: DriveCommentAction): Promise<void> {
  let [file] = await host.api.getScopeNodes([action.payload.fileId]);
  if (file?.canComment !== true) throw new ActionOutcomeUnknownError(LOOK_BLIND);
}

/** Whether a send's window has closed, so a look that finds nothing proves it posted nothing. */
function windowClosed(attempt: CommentAttempt): boolean {
  return attempt.at + RECONCILE_WINDOW_MS < Date.now() - CLOCK_SKEW_MS;
}

/** The end of a look that found nothing while Drive may still show what the send posted. */
function notShownYet(attempt: CommentAttempt): Error {
  let after = new Date(attempt.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS);
  return new Error("Google Drive may still be posting this, so it wasn't sent again; approve " +
    `again after ${after.toISOString().slice(11, 16)} UTC.`);
}

async function send(
  host: DriveCommentsHost, action: DriveCommentAction, placement: DocsPlacement | undefined,
): Promise<string> {
  let { api, docs } = host;
  let { payload } = action;
  switch (action.kind) {
    case "createComment":
      return placement
        ? docs.insertComment(payload.fileId, action.payload.content, placement.range,
          placement.revisionId)
        : (await api.createComment(payload.fileId, action.payload.content)).id;
    case "createReply":
      return (await api.createReply(payload.fileId, action.payload.commentId,
        { content: action.payload.content })).id;
    case "resolveComment":
      return (await api.createReply(payload.fileId, action.payload.commentId, {
        ...(action.payload.content === undefined ? {} : { content: action.payload.content }),
        action: "resolve",
      })).id;
    case "suggestEdit": {
      let { range } = placement!;
      let { newText } = action.payload;
      return docs.suggest(payload.fileId, [
        { deleteContentRange: { range } },
        ...(newText === "" ? [] : [{
          insertText: { location: { index: range.startIndex, tabId: range.tabId }, text: newText },
        }]),
      ], placement!.revisionId);
    }
  }
}

/** Google Docs' refusal, for good, of a send that posted nothing, in our words. */
function docsRefusal(error: unknown): string {
  if (docsFileInvisible(error)) return CANNOT_COMMENT;
  let status = error instanceof GoogleApiError ? error.providerStatus : undefined;
  return `Google Docs refused this${status ? ` [${status}]` : ""}.`;
}

/** Drive's refusal, for good, of a send that posted nothing, in our words. */
function refusal(error: unknown): string {
  if (!(error instanceof DriveApiRequestError)) return "Google Drive refused this comment.";
  if (error.reason === "commentLengthLimitExceeded") {
    return "Google Drive refused this comment as too long.";
  }
  if (error.reason === "insufficientFilePermissions") return CANNOT_COMMENT;
  if (error.status === 404) {
    return "Google Drive no longer shows this file or comment to the connected account.";
  }
  return `Google Drive refused this comment [http=${error.status}].`;
}

function rateLimited(google: string): string {
  return `${google} is limiting requests from this account. Approve it again in a minute.`;
}

/** Sends of one write that Drive may leave unconfirmed before it fails for good. */
const MAX_COMMENT_SENDS = 3;
const SENDS_EXHAUSTED = `Google Drive did not accept this in ${MAX_COMMENT_SENDS} tries, and ` +
  "none of them posted it, so it won't be sent again. Reject it to clear it.";

/**
 * Posts one approved write, looking first for what an earlier send of it may have posted. A
 * send's marker is dropped here only once the write is over with nothing posted: Google refused
 * it, a check failed it for good, or its third send was also found to have posted nothing. The
 * marker of a send proven empty stays until the next send's replaces it, so that the sends are
 * counted. One whose send posted, was found by a look, or cannot be told stays too, for the
 * gatekeeper to drop once the action's record is settled: until then a retry must find it and
 * look, never send.
 * @returns The ID Drive gave what was posted.
 */
async function post(
  host: DriveCommentsHost, id: number, action: DriveCommentAction,
): Promise<string> {
  let log = logger.with({ actionId: id, actionKind: action.kind, fileId: action.payload.fileId });
  let prior = host.attempts.get(id);
  // A suggestion known to be made is never made again; only its note may be left to post.
  if (action.kind === "suggestEdit" && prior?.suggestionId) {
    await postNote(host, id, action.payload, prior.suggestionId, prior);
    return prior.suggestionId;
  }
  let failedSends = 0;
  if (prior) {
    // Judged before the look: one taken while the window is open proves nothing by finding nothing.
    let conclusive = windowClosed(prior);
    let found = await findPosted(host, action, prior);
    if (found !== undefined) {
      log.info("found a Drive comment an earlier send posted", {
        event: "drive.comments.reconciled", commentId: found, outcome: "found",
      });
      if (action.kind === "suggestEdit") await postNote(host, id, action.payload, found, prior);
      return found;
    }
    if (!conclusive) throw notShownYet(prior);
    await requireSightedLook(host, action);
    // The window closed with nothing found by an account that would see it: that send posted
    // nothing.
    failedSends = (prior.failedSends ?? 0) + 1;
    if (failedSends >= MAX_COMMENT_SENDS) {
      host.attempts.delete(id);
      throw new ActionApplyError(SENDS_EXHAUSTED);
    }
  }

  let { comment, placement } = await (async () => {
    let answered = await requireStillAllowed(host, action);
    return { comment: answered, placement: await place(host, action) };
  })().catch((error: unknown) => {
    // Nothing applies a write that failed for good again, so its marker has no reader left.
    if (error instanceof ActionApplyError) host.attempts.delete(id);
    throw error;
  });
  let at = Date.now();
  // A reply already there, such as an earlier resolve of a since reopened comment, is not this
  // send's, nor is a suggestion the account had already made. Comments are not listed first:
  // taking an identical one for this send drops a duplicate.
  let existing = action.kind === "suggestEdit" ? placement!.mySuggestions
    : action.kind === "createComment" || !comment ? [] : comment.replies
      .filter(reply => mineFrom(reply, at - CLOCK_SKEW_MS) && looksSent(action, reply))
      .map(reply => reply.id);
  let attempt: CommentAttempt = {
    at, ...(existing.length ? { existing } : {}), ...(failedSends ? { failedSends } : {}),
  };
  host.attempts.put(id, attempt);
  let created: string;
  try {
    created = await send(host, action, placement);
    log.info("posted a Drive comment", {
      event: "drive.comments.posted", commentId: created, outcome: "posted",
      ...(placement ? { api: "docs" } : {}),
    });
  } catch (error) {
    let failure = placement ? docsWriteFailure(error) : commentWriteFailure(error);
    log.warn("Drive comment send failed", {
      event: "drive.comments.send.failed", outcome: failure, error,
      ...(error instanceof DriveApiRequestError
        ? { httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}) }
        : error instanceof GoogleApiError && error.providerReasons.length
          ? { providerReasons: [...error.providerReasons] } : {}),
    });
    let google = placement ? "Google Docs" : "Google Drive";
    if (failure === "unknown") {
      throw new Error(`${google} did not confirm whether this was posted, and it may have ` +
        `been. Approving it again first checks the file's ${
          action.kind === "suggestEdit" ? "suggestions" : "comments"}, so it is not posted ` +
        "twice; rejecting it leaves anything already posted on the file.", { cause: error });
    }
    host.attempts.delete(id);
    if (failure === "rateLimited") throw new Error(rateLimited(google), { cause: error });
    // The token lacks the scope, which allowing changes again lifts, as when the account says so.
    if (placement ? docsLacksScope(error) : isInsufficientScope(error)) {
      throw new Error(WRITES_GRANT_MISSING, { cause: error });
    }
    // Docs refuses a write on a revision other than the one read without saying which refusal it
    // is; a revision that moved says so, and a later approval places it on the Doc as it is then.
    if (placement?.revisionId !== undefined && docsWriteInvalid(error)) {
      let now = await host.docs.getRevisionId(action.payload.fileId).catch(() => undefined);
      if (now !== placement.revisionId) throw new Error(DOC_CHANGED_WHILE_SENT, { cause: error });
    }
    throw new ActionApplyError(placement ? docsRefusal(error) : refusal(error));
  }
  if (action.kind === "suggestEdit") {
    host.attempts.put(id, { ...attempt, suggestionId: created });
    await postNote(host, id, action.payload, created, attempt);
  }
  return created;
}

function fileLine(builder: ActionDescriptionBuilder, payload: CommentTargetPayload): void {
  builder.inline("File", payload.fileId);
  // Whoever may rename the file chose its name, so it is a field, never prose.
  if (payload.fileName !== undefined) builder.inline("File name", payload.fileName);
}

/** Said on an approval that shows only the start of the comment it answers. */
const PARENT_CUT =
  `Only the first ${PARENT_EXCERPT_CHARS} characters of the comment are shown below.`;

/**
 * The file and the comment a reply or resolve answers, shown after the reply itself. Someone else
 * on Drive wrote the comment and chose its author's name, so both are fields, which are shown as
 * written and never as Markdown.
 */
function parentLines(
  builder: ActionDescriptionBuilder, payload: DriveCommentActions["createReply" | "resolveComment"],
): void {
  let { author, excerpt, cut } = payload.parent;
  if (cut) builder.prose(PARENT_CUT);
  fileLine(builder, payload);
  builder.inline("Comment", payload.commentId);
  builder.inline("Comment author", author);
  builder.verbatim(cut ? "Comment text (start)" : "Comment text", excerpt);
}

const EMAILED = "Google emails the file's owner about new comments.";

/** The declared Drive comment writes. */
export const DRIVE_COMMENT_ACTIONS = defineActions<DriveCommentsHost, DriveCommentActions>({
  createComment: {
    kind: DRIVE_COMMENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Drive takes no idempotency key: a lost activation must not post twice.
    claimBeforeApply: true,
    describe: payload => {
      let { anchor } = payload;
      let builder = buildDescription(anchor
        ? `Post a comment on Google Doc ${codeSpan(payload.fileId)} as the connected account, ` +
          `attached to the quoted text. ${EMAILED}`
        : `Post a comment on Google Drive file ${codeSpan(payload.fileId)} as the connected ` +
          `account. It is plain text, not attached to text in the file. ${EMAILED}`);
      // What is posted comes first: the Workshop cuts a long card short.
      builder.verbatim("Comment", payload.content);
      // Anyone who can edit the Doc wrote the quoted text, so it is a field, never prose.
      if (anchor) builder.verbatim("Quoted text", anchor.text);
      fileLine(builder, payload);
      if (anchor) builder.inline("Tab", anchor.tabId);
      return {
        title: "Comment on a Google Drive file", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "createComment", payload });
    },
  },

  createReply: {
    kind: DRIVE_COMMENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let builder = buildDescription(
        `Reply to a comment on Google Drive file ${codeSpan(payload.fileId)} as the connected ` +
        `account. ${EMAILED}`);
      if (payload.reopens) builder.prose("This reopens the resolved comment.");
      builder.verbatim("Reply", payload.content);
      parentLines(builder, payload);
      return {
        title: "Reply to a Google Drive comment", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "createReply", payload });
    },
  },

  resolveComment: {
    kind: DRIVE_COMMENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let builder = buildDescription(
        `Resolve a comment on Google Drive file ${codeSpan(payload.fileId)} as the connected ` +
        `account${payload.content === undefined ? "" : ", with a closing reply"}.`);
      if (payload.content !== undefined) builder.verbatim("Reply", payload.content);
      parentLines(builder, payload);
      return {
        title: "Resolve a Google Drive comment", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "resolveComment", payload });
    },
  },

  suggestEdit: {
    kind: DRIVE_COMMENTS,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let deletes = payload.newText === "";
      let builder = buildDescription(
        `Suggest ${deletes ? "deleting text" : "replacing text"} in Google Doc ${
          codeSpan(payload.fileId)} as the connected account. It is a suggestion: the Doc's ` +
        "text does not change unless someone who can edit it accepts it." +
        (payload.note === undefined ? "" : " The note is posted as a reply on the suggestion."));
      // Anyone who can edit the Doc wrote the text replaced, so every text is a field.
      if (deletes) {
        builder.verbatim("Delete", payload.oldText);
      } else {
        builder.verbatim("Replace", payload.oldText);
        builder.verbatim("With", payload.newText);
      }
      if (payload.note !== undefined) builder.verbatim("Note", payload.note);
      fileLine(builder, payload);
      builder.inline("Tab", payload.tabId);
      return {
        title: "Suggest an edit in a Google Doc", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "suggestEdit", payload });
    },
  },
}, { fence: "none", vendorId: "google" });

/** Where a send's attempt marker is stored, by action ID. */
export const COMMENT_ATTEMPT_PREFIX = "driveComments:attempt:";

function attemptKey(id: number): string {
  return `${COMMENT_ATTEMPT_PREFIX}${id}`;
}

/** The attempt markers of one Drive binding, kept in its Durable Object's storage. */
export function commentAttempts(kv: DurableObjectStorage["kv"]): DriveCommentsHost["attempts"] & {
  /** Drops the markers of actions `keep` does not name: none of them can be applied again. */
  sweep(keep: ReadonlySet<number>): void;
} {
  return {
    get: id => kv.get<CommentAttempt>(attemptKey(id)),
    put: (id, attempt) => kv.put(attemptKey(id), attempt),
    delete: id => { kv.delete(attemptKey(id)); },
    sweep: keep => {
      for (let [stored] of kv.list({ prefix: COMMENT_ATTEMPT_PREFIX })) {
        let id = Number(stored.slice(COMMENT_ATTEMPT_PREFIX.length));
        if (!keep.has(id)) kv.delete(stored);
      }
    },
  };
}
