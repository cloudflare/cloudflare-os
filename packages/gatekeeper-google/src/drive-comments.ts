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
 *
 * The same writes serve a Google Drive binding and a directly bound Google Doc, each queued under
 * its own kind ({@link commentDefinitions}). They reach the file's comments through a
 * {@link CommentThreads} port: Drive's comment API for a Drive binding ({@link driveThreads}), and
 * the Docs API for a bound Doc, whose grant holds no Drive comment scope.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, type ActionDefinition, type JournalEntry,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, codeSpan, type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  DriveApiRequestError, isFileInvisible, isInsufficientScope, COMMENT_WRITE_MAX_MS,
  type DriveWriteFailure,
  type DriveApi, type DriveCommentRecord, type DriveReplyRecord,
} from "./drive-api";
import {
  DOCS_WRITE_MAX_MS, DocsCommentNotSavedError, docsFileInvisible, docsLacksScope,
  docsWriteFailure, docsWriteInvalid, type DocsRange,
  type DocsSuggestionRecord, type GoogleDocsApi, type GoogleDocsDocument,
} from "./docs-api";
import { locateQuote, selectTab } from "./drive-comment-body";
import type { DocSuggestion, DriveComment, DriveCommentReply } from "./drive-types";
import { GoogleApiError } from "./google-response";
import {
  isLiftable, pendingId, proveTarget, sendOnce, WRITES_GRANT_MISSING,
  type DriveWritesHost, type DriveWriteTargetPayload, type QueuedWrite, type WriteAttempt,
  type writeAttempts,
} from "./drive-writes";
import { obsContext } from "./observability";

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

/** The refusal for a reply to, or a resolve of, a comment that is itself still queued. */
const PENDING_COMMENT_REFUSED =
  "That comment is waiting for approval; reply to it once it is posted.";

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
const NO_REVISION = "Google Docs did not give the connected account the Doc's revision, so the " +
  "quoted text can't be held in place while this is sent.";
const THREAD_NOT_SAVED = "The suggestion was made, but Google Docs did not save its thread, so " +
  "its note can't be posted.";
const COMMENT_NOT_SAVED = "Google Docs answered that it did not save this comment, so nothing was " +
  "posted. Approve it again to post it.";
const DOC_CHANGED_WHILE_SENT = "The Google Doc changed while this was being sent, so nothing " +
  "was posted. Approve it again to place it on the Doc as it is now.";

/** The refusal for a reply to, or a resolve of, the `pending:` ID of a suggested edit. */
const PENDING_SUGGESTION_REFUSED =
  "That pending ID names a suggested edit, which takes no replies here; once it is approved, " +
  "the Doc's owner answers it in the Doc.";

/** Longest excerpt of the comment a reply answers that its approval shows, in characters. */
const PARENT_EXCERPT_CHARS = 200;

/** How far Drive's clock may run behind ours. */
const CLOCK_SKEW_MS = 10_000;
/** How long after a send began Drive may date what it posted: well past the write's own timeout. */
const RECONCILE_WINDOW_MS =
  Math.max(5 * 60 * 1000, 2 * Math.max(COMMENT_WRITE_MAX_MS, DOCS_WRITE_MAX_MS));
/** Most pages one look for a posted comment reads. */
const MAX_RECONCILE_PAGES = 50;

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

/**
 * What every Drive comment write carries about the file it is on: the target every Drive write is
 * proved by at apply, and the time a pending comment or reply shows.
 */
export type CommentTargetPayload = DriveWriteTargetPayload & {
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

/**
 * A file's comments as one binding reaches them, for applying and checking a comment write. Every
 * record is in Drive's shape: Docs lists the same comments under the same IDs.
 */
export type CommentThreads = {
  /** The Google product a write's outcome names, such as "Google Drive". */
  via: string;
  /** What a request refused for a missing scope fails with; the write stays pending. */
  grantMissing: string;
  /**
   * The file a write is on as the binding's scope reaches it now, with whether the account may
   * comment on it, or `undefined` when it is out of scope or invisible.
   */
  target(payload: CommentTargetPayload): Promise<{ canComment?: boolean } | undefined>;
  /** One comment as it stands, or `undefined` once it is deleted or not found. */
  comment(fileId: string, commentId: string): Promise<DriveCommentRecord | undefined>;
  /** The file's comments modified at or after `since` (epoch ms): where a look finds a comment. */
  postedComments(fileId: string, since: number): Promise<DriveCommentRecord[]>;
  /** A comment's replies, where a look finds a reply or resolve; rejects once it is gone. */
  replies(fileId: string, commentId: string): Promise<DriveReplyRecord[]>;
  /** Posts a reply, or with `resolve` a resolve, returning its ID. */
  reply(
    fileId: string, commentId: string, post: { content?: string; resolve?: true },
  ): Promise<string>;
  /** Posts a comment attached to no text, returning its ID. */
  createUnanchored(fileId: string, content: string): Promise<string>;
  /**
   * Whether a look that found nothing could have seen what it looked for: Google shows an account
   * that cannot comment on a file none of its comments, and may answer that with no error.
   */
  sighted(fileId: string): Promise<boolean>;
  /**
   * How a failed {@link reply} or {@link createUnanchored} failed, for threads reached through
   * another Google API than Drive's; Drive's classification when absent.
   */
  sendFailure?(error: unknown): DriveWriteFailure;
  /** A send's refusal, for good and having made nothing, in our words. */
  refusal(error: unknown): string;
  /** Whether a request was refused because the token lacks a scope. */
  lacksScope(error: unknown): boolean;
  /** Whether a request was refused because the file or comment is gone or hidden. */
  invisible(error: unknown): boolean;
};

/** What applying a comment write needs, whichever binding queued it. */
export type CommentHost = {
  threads: CommentThreads;
  /** The Docs API, through which comments that quote a Doc and suggested edits are sent. */
  docs: Pick<GoogleDocsApi,
    "getDocumentWithSuggestions" | "getRevisionId" | "insertComment" | "suggest" |
    "replyToSuggestion">;
  /** Why this binding cannot make changes now, read when an action applies. */
  writeRefusal(): Promise<string | undefined>;
  /** The attempt markers a handler reads and writes. */
  attempts: Pick<ReturnType<typeof writeAttempts>, "get" | "put" | "delete">;
};

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
export function pendingCommentRefusal(commentId: string, pending: readonly QueuedWrite[]): string {
  let named = commentEntries(pending).find(({ id }) => pendingId(id) === commentId)?.action.kind;
  return named === "createComment" ? PENDING_COMMENT_REFUSED
    : named === "suggestEdit" ? PENDING_SUGGESTION_REFUSED : PENDING_COMMENT_DECIDED;
}

/** Whether `pending` holds a resolve of comment `commentId` on file `fileId`. */
export function hasPendingResolve(
  fileId: string, commentId: string, pending: readonly QueuedWrite[],
): boolean {
  return commentEntries(pending).some(({ action }) =>
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
    id: pendingId(id), author: PENDING_AUTHOR, text: payload.content,
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
    id: pendingId(id), tabId, oldText, newText, ...(note === undefined ? {} : { note }),
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
    id: pendingId(id), author: PENDING_AUTHOR, text: payload.content ?? "",
    createdTime: new Date(payload.queuedAt), ...(replyAction ? { action: replyAction } : {}),
    pending: true,
  };
}

/** Whether `entry` is a comment write: one queued under a comment definition's name. */
function isCommentEntry(entry: QueuedWrite): entry is JournalEntry<DriveCommentAction> {
  return Object.hasOwn(DRIVE_COMMENT_DEFINITIONS, entry.action.kind);
}

/** The comment writes among `pending`. */
export function commentEntries(
  pending: readonly QueuedWrite[],
): JournalEntry<DriveCommentAction>[] {
  return pending.filter(isCommentEntry);
}

/**
 * One page of `fileId`'s comments with this binding's undecided writes for the file: each queued
 * reply or resolve under the comment it answers, and, on the last page, each queued comment. A
 * queued suggested edit is not shown: Drive lists no suggestion. `pending` holds the binding's
 * undecided writes of every kind, of which the comment ones are read. `quotesDocument` says
 * whether the page shows a queued comment that quotes the file as a Google Doc.
 */
export function overlayPending(
  fileId: string,
  comments: DriveComment[],
  pending: readonly QueuedWrite[],
  last: boolean,
): { comments: DriveComment[]; quotesDocument: boolean } {
  let mine = commentEntries(pending).filter(({ action }) => action.payload.fileId === fileId);
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
 * Refuses, for good, a write on a file the binding's scope no longer reaches, or one the connected
 * account can no longer comment on.
 */
async function requireInScope(host: CommentHost, payload: CommentTargetPayload): Promise<void> {
  let file = await host.threads.target(payload);
  if (!file) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
  if (file.canComment !== true) throw new ActionApplyError(CANNOT_COMMENT);
}

/**
 * Refuses a write that may not be made at apply, having posted nothing: for good, except for a
 * refusal a later approval can pass, which leaves the write pending.
 * @returns What the send's marker notes: the account's replies already on the comment that look
 * like what this send posts.
 */
async function requireStillAllowed(
  host: CommentHost, action: DriveCommentAction,
): Promise<{ existing?: string[] }> {
  let refused = await host.writeRefusal();
  // A refusal a later approval can pass leaves the write pending; any other fails it for good.
  if (refused !== undefined) {
    throw refused === host.threads.grantMissing || isLiftable(refused)
      ? new Error(refused) : new ActionApplyError(refused);
  }
  await requireInScope(host, action.payload);
  if (action.kind === "createComment" || action.kind === "suggestEdit") return {};
  let comment = await host.threads.comment(action.payload.fileId, action.payload.commentId);
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
  // A reply already there, such as an earlier resolve of a since reopened comment, is not this
  // send's. Comments are not listed first: taking an identical one for this send drops a duplicate.
  let from = Date.now() - CLOCK_SKEW_MS;
  return {
    existing: comment.replies
      .filter(reply => mineFrom(reply, from) && looksSent(action, reply))
      .map(reply => reply.id),
  };
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
  host: CommentHost, action: DriveCommentAction, attempt: WriteAttempt,
): Promise<string | undefined> {
  if (action.kind === "suggestEdit") return findSuggestion(host, action.payload, attempt);
  let from = attempt.at - CLOCK_SKEW_MS;
  let until = attempt.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS;
  let around = (item: DriveCommentRecord | DriveReplyRecord) =>
    mineFrom(item, from, until) && !attempt.existing?.includes(item.id);
  let { payload } = action;
  let { threads } = host;
  let candidates: (DriveCommentRecord | DriveReplyRecord)[];
  try {
    if (action.kind === "createComment") {
      // Drive lists a comment made through Docs under the same ID, with the content as sent.
      // A comment is modified no earlier than it was created.
      candidates = (await threads.postedComments(payload.fileId, from))
        .filter(comment => around(comment) && comment.content === action.payload.content);
    } else {
      candidates = (await threads.replies(payload.fileId, action.payload.commentId))
        .filter(reply => around(reply) && looksSent(action, reply));
    }
  } catch (error) {
    // A token without the scope cannot look at all. That says nothing of the file, and allowing
    // changes again lifts it, so the write waits with its marker, as after a send refused for it.
    if (threads.lacksScope(error)) throw new Error(threads.grantMissing, { cause: error });
    if (!threads.invisible(error)) throw error;
    throw new ActionOutcomeUnknownError(
      `${threads.via} no longer shows this file or comment to the connected account, so whether ` +
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
  host: CommentHost, fileId: string, look: boolean,
): Promise<{ document: GoogleDocsDocument; suggestions: DocsSuggestionRecord[] }> {
  try {
    return await host.docs.getDocumentWithSuggestions(fileId);
  } catch (error) {
    if (docsLacksScope(error)) throw new Error(host.threads.grantMissing, { cause: error });
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
  host: CommentHost, payload: DriveCommentActions["suggestEdit"], attempt: WriteAttempt,
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
  host: CommentHost, action: DriveCommentAction,
): Promise<DocsPlacement | undefined> {
  let quoted = action.kind === "createComment" ? action.payload.anchor
    : action.kind === "suggestEdit"
      ? { tabId: action.payload.tabId, text: action.payload.oldText } : undefined;
  if (!quoted) return undefined;
  let { document, suggestions } = await readDoc(host, action.payload.fileId, false);
  let range: DocsRange;
  try {
    range = locateQuote(selectTab(document, quoted.tabId), quoted.text,
      { wholeChips: action.kind === "suggestEdit" });
  } catch (error) {
    throw new ActionApplyError(QUOTE_GONE, { cause: error });
  }
  // A range is placed by the read: without its revision to send on, an edit made meanwhile would
  // move it. Google gives one to every account that can comment, so this is not expected.
  if (!document.revisionId) throw new ActionApplyError(NO_REVISION);
  return {
    range, revisionId: document.revisionId,
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
  host: CommentHost, id: number, payload: DriveCommentActions["suggestEdit"],
  suggestionId: string, attempt: WriteAttempt,
): Promise<void> {
  let { note } = payload;
  let marked: WriteAttempt = { ...attempt, suggestionId };
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
    if (thread.replies.some(reply => myPostFrom(reply, from) && reply.content === note)) {
      host.attempts.put(id, { ...marked, postedId: suggestionId });
      return;
    }
    if (!conclusive) throw notShownYet(noteAttempt, "Google Docs");
    await requireSightedLook(host, { kind: "suggestEdit", payload });
  }
  // The note is a write of its own: the binding's checks hold for it as for the suggestion, and
  // the suggestion's ID stays in the marker whatever they answer.
  await requireStillAllowed(host, { kind: "suggestEdit", payload }).catch((error: unknown) => {
    if (!(error instanceof ActionApplyError)) throw error;
    throw new ActionApplyError(`The suggestion was made, but its note was not posted: ${
      error.message}`, { cause: error });
  });
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
    if (error instanceof DocsCommentNotSavedError) {
      throw new Error("The suggestion was made, but Google Docs did not save its note. Approve " +
        "it again to post the note.", { cause: error });
    }
    if (failure === "rateLimited") throw new Error(rateLimited("Google Docs"), { cause: error });
    if (docsLacksScope(error)) throw new Error(host.threads.grantMissing, { cause: error });
    throw new ActionApplyError("The suggestion was made, but Google Docs refused its note.",
      { cause: error });
  }
  // Over: a retry, after an apply that could not be recorded, must not post the note again.
  host.attempts.put(id, { ...marked, postedId: suggestionId });
}

/**
 * Refuses to take a look that found nothing for proof that nothing was posted, when it could have
 * found nothing either way: Drive lists an account that cannot comment on a file none of its
 * comments, its own included, and answers with no error.
 * @throws ActionOutcomeUnknownError when the connected account cannot comment on the file now.
 */
async function requireSightedLook(host: CommentHost, action: DriveCommentAction): Promise<void> {
  let { threads } = host;
  if (await threads.sighted(action.payload.fileId)) return;
  throw new ActionOutcomeUnknownError(`The connected account can no longer comment on that file, ` +
    `and ${threads.via} shows a file's comments only to accounts that can, so whether this was ` +
    "posted can't be checked, and it won't be sent again. Reject it to clear it.");
}

/** Whether a send's window has closed, so a look that finds nothing proves it posted nothing. */
function windowClosed(attempt: WriteAttempt): boolean {
  return attempt.at + RECONCILE_WINDOW_MS < Date.now() - CLOCK_SKEW_MS;
}

/** The end of a look that found nothing while `via` may still show what the send posted. */
function notShownYet(attempt: WriteAttempt, via: string): Error {
  let after = new Date(attempt.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS);
  return new Error(`${via} may still be posting this, so it wasn't sent again; approve ` +
    `again after ${after.toISOString().slice(11, 16)} UTC.`);
}

/**
 * Sends one write. `threadSaved` is false only for a suggestion Google made without saving its
 * comment thread; any other unsaved post fails.
 */
async function send(
  host: CommentHost, action: DriveCommentAction, placement: DocsPlacement | undefined,
): Promise<{ id: string; threadSaved: boolean }> {
  let { threads, docs } = host;
  let { payload } = action;
  let saved = async (id: Promise<string>) => ({ id: await id, threadSaved: true });
  switch (action.kind) {
    case "createComment":
      return saved(placement
        ? docs.insertComment(payload.fileId, action.payload.content, placement.range,
          placement.revisionId)
        : threads.createUnanchored(payload.fileId, action.payload.content));
    case "createReply":
      return saved(threads.reply(payload.fileId, action.payload.commentId,
        { content: action.payload.content }));
    case "resolveComment":
      return saved(threads.reply(payload.fileId, action.payload.commentId, {
        ...(action.payload.content === undefined ? {} : { content: action.payload.content }),
        resolve: true,
      }));
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

/** Said of a send `google` refused for the rate of requests, which it may take later. */
function rateLimited(google: string): string {
  return `${google} is limiting requests from this account. Approve it again in a minute.`;
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

/** Sends of one write that Drive may leave unconfirmed before it fails for good. */
const MAX_COMMENT_SENDS = 3;
const SENDS_EXHAUSTED = `Google Drive did not accept this in ${MAX_COMMENT_SENDS} tries, and ` +
  "none of them posted it, so it won't be sent again. Reject it to clear it.";

/**
 * Said when `google` leaves open whether a send posted: Google Drive, or Google Docs for a comment
 * that quotes a Doc, a suggestion, or anything a bound Doc posts.
 */
function unconfirmedSend(google: string, what: "comments" | "suggestions"): string {
  return `${google} did not confirm whether this was posted, and it may have been. Approving ` +
    `it again first checks the file's ${what}, so it is not posted twice; rejecting it leaves ` +
    "anything already posted on the file.";
}

/**
 * How a Docs send failed, as {@link sendOnce} reads a failure. A 401 is `unauthorized` here, where
 * Drive reads one on a write that cannot be repeated as `absent`: Docs refused it before acting, so
 * the write stays pending for an approval under the account's token as it is then, and sendOnce
 * drops its marker, so that approval sends it at once.
 */
export function docsSendFailure(error: unknown): DriveWriteFailure {
  if (error instanceof GoogleApiError && error.providerStatus === "UNAUTHENTICATED") {
    return "unauthorized";
  }
  return docsWriteFailure(error);
}

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
  host: CommentHost, id: number, action: DriveCommentAction,
): Promise<string> {
  let { threads } = host;
  let log = logger.with({ actionId: id, actionKind: action.kind, fileId: action.payload.fileId });
  let prior = host.attempts.get(id);
  // A send Google confirmed is over, whatever has become of its post since.
  if (prior?.postedId) return prior.postedId;
  // A suggestion known to be made is never made again; only its note may be left to post.
  if (action.kind === "suggestEdit" && prior?.suggestionId) {
    await postNote(host, id, action.payload, prior.suggestionId, prior);
    return prior.suggestionId;
  }
  let docs = action.kind === "suggestEdit" ||
    (action.kind === "createComment" && action.payload.anchor !== undefined);
  // Found by the check at apply, which reads the Doc again, and used by the send that follows it.
  let placement: DocsPlacement | undefined;
  // False only once Google made a suggestion without saving its thread.
  let threadSaved = true;
  let made = await sendOnce<string>(host, id, {
    log,
    events: "drive.comments",
    applied: { event: "posted", outcome: "posted" },
    look: async prior => {
      // Judged before the look: one taken while the window is open proves nothing by finding
      // nothing.
      let conclusive = windowClosed(prior);
      let found = await findPosted(host, action, prior);
      if (found !== undefined) return { found };
      // Nothing found proves nothing was posted only from an account that would see it.
      if (conclusive) await requireSightedLook(host, action);
      // A suggestion is looked for in the Doc; a comment, anchored or not, in the binding's listing.
      return { conclusive, retry: notShownYet(prior,
        action.kind === "suggestEdit" ? "Google Docs" : threads.via) };
    },
    check: async () => {
      let noted = await requireStillAllowed(host, action);
      placement = await place(host, action);
      // The file may have left the scope while the Doc was read.
      if (placement) await requireInScope(host, action.payload);
      // A suggestion the account had already made is not this send's.
      return action.kind === "suggestEdit" ? { existing: placement!.mySuggestions } : noted;
    },
    send: async () => {
      let sent = await send(host, action, placement);
      threadSaved = sent.threadSaved;
      return sent.id;
    },
    repeatable: false,
    exhausted: { sends: MAX_COMMENT_SENDS, message: SENDS_EXHAUSTED },
    grantMissing: threads.grantMissing,
    ...(docs ? { failure: docsSendFailure }
      : threads.sendFailure ? { failure: threads.sendFailure } : {}),
    passable: async (error: unknown) => {
      // Said by Docs, of a comment, reply or note sent through it, whichever binding sent it.
      if (error instanceof DocsCommentNotSavedError) return COMMENT_NOT_SAVED;
      // Docs refuses a write on a revision other than the one read without saying which refusal
      // it is; a revision that moved says so, and a later approval places it on the Doc as it is.
      let revisionId = placement?.revisionId;
      if (revisionId === undefined || !docsWriteInvalid(error)) return undefined;
      let now = await host.docs.getRevisionId(action.payload.fileId).catch(() => undefined);
      return now === revisionId ? undefined : DOC_CHANGED_WHILE_SENT;
    },
    refusal: docs ? docsRefusal : threads.refusal,
    unconfirmed: unconfirmedSend(docs ? "Google Docs" : threads.via,
      action.kind === "suggestEdit" ? "suggestions" : "comments"),
    rateLimited: rateLimited(docs ? "Google Docs" : threads.via),
    logFields: commentId => ({ commentId }),
  });
  let attempt = host.attempts.get(id) ?? { at: Date.now() };
  if (action.kind !== "suggestEdit") {
    host.attempts.put(id, { ...attempt, postedId: made });
    return made;
  }
  if (attempt.suggestionId !== made) host.attempts.put(id, { ...attempt, suggestionId: made });
  if (!threadSaved) {
    log.warn("Google Docs made a suggestion without saving its thread", {
      event: "drive.comments.thread.unsaved", commentId: made, outcome: "posted",
    });
    // The suggestion stands, and is not made again; there is no thread for its note.
    if (action.payload.note !== undefined) throw new ActionApplyError(THREAD_NOT_SAVED);
    return made;
  }
  await postNote(host, id, action.payload, made, attempt);
  return made;
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

/** How one binding's cards name the file a write is on, and their titles. */
export type CommentWording = {
  /** The file in a reply's or resolve's prose, as "Google Drive file". */
  file: string;
  /** The title of a comment's card. */
  commentTitle: string;
  /** What a reply's and a resolve's titles call the comment, as "Google Drive" for "a Google Drive comment". */
  thread: string;
};

/** The four comment writes of one binding, each an action definition over its host. */
export type CommentDefinitions<Host> = {
  [K in keyof DriveCommentActions]: ActionDefinition<DriveCommentActions[K], Host>;
};

/**
 * The four comment writes, queued as `kind` with `wording` on their cards, applied through the
 * port `port` builds from the binding's host for each call.
 */
export function commentDefinitions<Host>(
  kind: ActionKind, wording: CommentWording, port: (host: Host) => CommentHost,
): CommentDefinitions<Host> {
  return {
  createComment: {
    kind,
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
        title: wording.commentTitle, ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(port(host), ctx.id, { kind: "createComment", payload });
    },
  },

  createReply: {
    kind,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let builder = buildDescription(
        `Reply to a comment on ${wording.file} ${codeSpan(payload.fileId)} as the connected ` +
        `account. ${EMAILED}`);
      if (payload.reopens) builder.prose("This reopens the resolved comment.");
      builder.verbatim("Reply", payload.content);
      parentLines(builder, payload);
      return {
        title: `Reply to a ${wording.thread} comment`, ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(port(host), ctx.id, { kind: "createReply", payload });
    },
  },

  resolveComment: {
    kind,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: payload => {
      let builder = buildDescription(
        `Resolve a comment on ${wording.file} ${codeSpan(payload.fileId)} as the connected ` +
        `account${payload.content === undefined ? "" : ", with a closing reply"}.`);
      if (payload.content !== undefined) builder.verbatim("Reply", payload.content);
      parentLines(builder, payload);
      return {
        title: `Resolve a ${wording.thread} comment`, ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(port(host), ctx.id, { kind: "resolveComment", payload });
    },
  },

  suggestEdit: {
    kind,
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
      await post(port(host), ctx.id, { kind: "suggestEdit", payload });
    },
  },
};
}

/**
 * A Drive binding's comment threads: Drive's comment API, within the binding's scope, read when an
 * action applies.
 */
export function driveThreads(host: Pick<DriveWritesHost, "api" | "scope">): CommentThreads {
  let { api } = host;
  return {
    via: "Google Drive",
    grantMissing: WRITES_GRANT_MISSING,
    target: payload => proveTarget(host, payload),
    comment: (fileId, commentId) => readLiveComment(api, fileId, commentId),
    // Inclusive.
    postedComments: (fileId, since) => {
      let startModifiedTime = new Date(since).toISOString();
      return readAll(async pageToken => {
        let page = await api.listComments(fileId,
          { startModifiedTime, ...(pageToken ? { pageToken } : {}) });
        return { items: page.comments, nextPageToken: page.nextPageToken };
      });
    },
    replies: (fileId, commentId) => readAll(async pageToken => {
      let page = await api.listReplies(fileId, commentId, pageToken ? { pageToken } : {});
      return { items: page.replies, nextPageToken: page.nextPageToken };
    }),
    reply: async (fileId, commentId, { content, resolve }) => (await api.createReply(fileId,
      commentId, { ...(content === undefined ? {} : { content }),
        ...(resolve ? { action: "resolve" as const } : {}) })).id,
    createUnanchored: async (fileId, content) => (await api.createComment(fileId, content)).id,
    sighted: async fileId => (await api.getScopeNodes([fileId]))[0]?.canComment === true,
    refusal,
    lacksScope: isInsufficientScope,
    invisible: isFileInvisible,
  };
}

/** The declared Drive comment writes, which drive-actions.ts combines with the others. */
export const DRIVE_COMMENT_DEFINITIONS = commentDefinitions<DriveWritesHost>(DRIVE_COMMENTS, {
  file: "Google Drive file", commentTitle: "Comment on a Google Drive file", thread: "Google Drive",
}, host => ({
  threads: driveThreads(host),
  docs: host.docs,
  writeRefusal: () => host.writeRefusal(),
  attempts: host.attempts,
}));
