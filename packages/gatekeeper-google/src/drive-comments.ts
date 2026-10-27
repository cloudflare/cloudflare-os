/**
 * Approval-backed Drive comments: what each write queues, how it is described, how an approved one
 * is posted, and how a session shows the writes still awaiting a decision.
 *
 * Drive takes no idempotency key for a comment, and an error answer does not prove nothing was
 * posted: Drive applies a write before it checks the response mask. So a send leaves a marker
 * before it goes, and an apply that finds one looks for what that send posted before it sends
 * again. Comments do not depend on one another or on the connection they were queued under; the
 * grant, the binding's scope and the account's permission to comment are checked again at apply.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, defineActions, type ActionSubmitter,
  type JournalEntry, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, codeSpan, plainInline, quoteUntrusted, type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  commentWriteFailure, DriveApiRequestError, isFileInvisible, isInsufficientScope,
  COMMENT_WRITE_MAX_MS, type DriveApi, type DriveCommentRecord, type DriveReplyRecord,
  type DriveScopeNode,
} from "./drive-api";
import { isDirectChild, readFolderLocation } from "./drive-folder-scope";
import type { DriveBindingScope } from "./drive-session";
import type { DriveComment, DriveCommentReply } from "./drive-types";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.comments", vendorId: "google",
});

/** The one kind every Drive comment write is queued as, so one rule auto-approves them all. */
const DRIVE_COMMENTS: ActionKind = { tag: "driveComments", label: "Drive comments" };

/** The refusal for a connection that has not opted in to commenting. */
export const COMMENT_GRANT_MISSING =
  "Commenting needs a permission this Google account hasn't granted yet. In Workshop, start " +
  "adding a Google Drive connection for this account and choose \"Allow commenting\"; it " +
  "covers every Drive connection on the account, so the dialog can then be closed.";

/** The refusal for a reply to, or a resolve of, a comment that is itself still queued. */
export const PENDING_COMMENT_REFUSED =
  "That comment is waiting for approval; reply to it once it is posted.";

/** The refusal for resolving a resolved comment, which Drive would accept with another reply. */
export const ALREADY_RESOLVED = "That comment is already resolved.";

/** The refusal for a reply to, or a resolve of, a comment Drive does not show. */
export const COMMENT_NOT_FOUND = "That comment was not found on this file.";

const RESOLVED_SINCE_QUEUED = "That comment was resolved after this reply was queued, and " +
  "replying would reopen it. Queue the reply again to reopen it.";
const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const CANNOT_COMMENT = "The connected account can no longer comment on that file.";

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

/** The comment a reply or resolve answers, as it stood when queued, for the approver. */
export type CommentParent = { author: string; excerpt: string };

/** What every Drive comment write carries about the file it is on. */
export type CommentTargetPayload = {
  fileId: string;
  /** For a folder binding, the path from the bound root to the file's parent, proven at apply. */
  folderIds?: string[];
  /** RFC 3339, shown as the pending item's creation time. */
  queuedAt: string;
};

/** Each Drive comment write, by the action kind it is queued as. */
export type DriveCommentActions = {
  createComment: CommentTargetPayload & { content: string };
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
};

/** One queued Drive comment write. */
export type DriveCommentAction = TaggedAction<DriveCommentActions>;

/** What a Drive session needs of its gatekeeper to show and queue comment writes. */
export type DriveCommentQueue = {
  /** Whether the connection holds the commenting grant, read live. */
  holdsGrant(): Promise<boolean>;
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
  /** The account's replies already on the comment that look like what this send posts. */
  existing?: string[];
};

/** What applying a Drive comment write needs. */
export type DriveCommentsHost = {
  api: Pick<DriveApi,
    "getScopeNodes" | "getComment" | "listComments" | "listReplies" | "createComment" |
    "createReply">;
  /** The binding's scope, read when an action applies. */
  scope(): DriveBindingScope;
  /** Whether the connection holds the commenting grant, read live. */
  holdsGrant(): Promise<boolean>;
  /** Sends whose outcome Drive never reported, by action ID. */
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

/** What the approval of a reply or resolve shows of the comment it answers. */
export function commentParent(comment: DriveCommentRecord): CommentParent {
  return {
    author: comment.author.displayName,
    excerpt: [...comment.content].slice(0, PARENT_EXCERPT_CHARS).join(""),
  };
}

function toReply(reply: DriveReplyRecord): DriveCommentReply {
  return {
    id: reply.id,
    author: { name: reply.author.displayName, me: reply.author.me },
    text: reply.content,
    createdTime: reply.createdTime,
    ...(reply.modifiedTime === undefined ? {} : { modifiedTime: reply.modifiedTime }),
    ...(reply.action === undefined ? {} : { action: reply.action }),
  };
}

/** Maps one Drive comment to the agent's shape, deleted replies left out. */
export function toDriveComment(comment: DriveCommentRecord): DriveComment {
  return {
    id: comment.id,
    author: { name: comment.author.displayName, me: comment.author.me },
    text: comment.content,
    createdTime: comment.createdTime,
    ...(comment.modifiedTime === undefined ? {} : { modifiedTime: comment.modifiedTime }),
    resolved: comment.resolved,
    replies: comment.replies.filter(reply => !reply.deleted).map(toReply),
  };
}

const PENDING_AUTHOR = { name: "You", me: true };

/** The queued comment `id` will post, as the session shows it. */
export function pendingComment(
  id: number, payload: DriveCommentActions["createComment"],
): DriveComment {
  return {
    id: `${PENDING_PREFIX}${id}`, author: PENDING_AUTHOR, text: payload.content,
    createdTime: payload.queuedAt, resolved: false, replies: [], pending: true,
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
    createdTime: payload.queuedAt, ...(replyAction ? { action: replyAction } : {}), pending: true,
  };
}

/**
 * One page of `fileId`'s comments with this binding's undecided writes for the file: each queued
 * reply or resolve under the comment it answers, and, on the last page, each queued comment.
 */
export function overlayPending(
  fileId: string,
  comments: DriveComment[],
  pending: readonly JournalEntry<DriveCommentAction>[],
  last: boolean,
): DriveComment[] {
  let mine = pending.filter(({ action }) => action.payload.fileId === fileId);
  let shown = comments.map(comment => {
    let replies = mine.flatMap(({ id, action }) =>
      action.kind !== "createComment" && action.payload.commentId === comment.id
        ? [pendingReply(id, action)] : []);
    return replies.length ? { ...comment, replies: [...comment.replies, ...replies] } : comment;
  });
  if (last) {
    for (let { id, action } of mine) {
      if (action.kind === "createComment") shown.push(pendingComment(id, action.payload));
    }
  }
  return shown;
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
 * Refuses, as known not to have posted anything, a write that may not be made at apply.
 * @returns The comment a reply or resolve answers, as it stands now.
 */
async function requireStillAllowed(
  host: DriveCommentsHost, action: DriveCommentAction,
): Promise<DriveCommentRecord | undefined> {
  if (!(await host.holdsGrant())) throw new ActionApplyError(COMMENT_GRANT_MISSING);
  let file = await scopedFile(host, action.payload);
  if (!file) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
  if (file.canComment !== true) throw new ActionApplyError(CANNOT_COMMENT);
  if (action.kind === "createComment") return undefined;
  let comment = await readLiveComment(host.api, action.payload.fileId, action.payload.commentId);
  if (!comment) throw new ActionApplyError(COMMENT_NOT_FOUND);
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
 * sent (Drive stores it byte for byte) and, for a resolve, the resolve action.
 * @returns Its ID, or `undefined` when there is none: proof nothing was posted only once the
 * attempt's window has closed.
 * @throws ActionOutcomeUnknownError when more than one matches, or the file or comment is gone.
 */
async function findPosted(
  host: DriveCommentsHost, action: DriveCommentAction, attempt: CommentAttempt,
): Promise<string | undefined> {
  let from = attempt.at - CLOCK_SKEW_MS;
  let until = attempt.at + RECONCILE_WINDOW_MS + CLOCK_SKEW_MS;
  let around = (item: DriveCommentRecord | DriveReplyRecord) =>
    mineFrom(item, from, until) && !attempt.existing?.includes(item.id);
  let { payload } = action;
  let candidates: (DriveCommentRecord | DriveReplyRecord)[];
  try {
    if (action.kind === "createComment") {
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

function send(api: DriveCommentsHost["api"], action: DriveCommentAction): Promise<{ id: string }> {
  let { payload } = action;
  switch (action.kind) {
    case "createComment": return api.createComment(payload.fileId, action.payload.content);
    case "createReply":
      return api.createReply(payload.fileId, action.payload.commentId,
        { content: action.payload.content });
    case "resolveComment":
      return api.createReply(payload.fileId, action.payload.commentId, {
        ...(action.payload.content === undefined ? {} : { content: action.payload.content }),
        action: "resolve",
      });
  }
}

/** Drive's refusal of a send that posted nothing, in our words. */
function refusal(error: unknown): string {
  if (isInsufficientScope(error)) return COMMENT_GRANT_MISSING;
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

/**
 * Posts one approved write, looking first for what an earlier send of it may have posted.
 * @returns The ID Drive gave what was posted.
 */
async function post(
  host: DriveCommentsHost, id: number, action: DriveCommentAction,
): Promise<string> {
  let log = logger.with({ actionId: id, actionKind: action.kind, fileId: action.payload.fileId });
  let prior = host.attempts.get(id);
  if (prior) {
    // Judged before the look: one taken while the window is open proves nothing by finding nothing.
    let conclusive = windowClosed(prior);
    let found: string | undefined;
    try {
      found = await findPosted(host, action, prior);
    } catch (error) {
      if (error instanceof ActionOutcomeUnknownError) host.attempts.delete(id);
      throw error;
    }
    if (found !== undefined) {
      host.attempts.delete(id);
      log.info("found a Drive comment an earlier send posted", {
        event: "drive.comments.reconciled", commentId: found, outcome: "found",
      });
      return found;
    }
    if (!conclusive) throw notShownYet(prior);
    host.attempts.delete(id);
  }

  let comment = await requireStillAllowed(host, action);
  let at = Date.now();
  // A reply already there, such as an earlier resolve of a since reopened comment, is not this
  // send's. Comments are not listed first: taking an identical one for this send drops a duplicate.
  let existing = action.kind === "createComment" || !comment ? [] : comment.replies
    .filter(reply => mineFrom(reply, at - CLOCK_SKEW_MS) && looksSent(action, reply))
    .map(reply => reply.id);
  host.attempts.put(id, { at, ...(existing.length ? { existing } : {}) });
  try {
    let created = await send(host.api, action);
    host.attempts.delete(id);
    log.info("posted a Drive comment", {
      event: "drive.comments.posted", commentId: created.id, outcome: "posted",
    });
    return created.id;
  } catch (error) {
    let failure = commentWriteFailure(error);
    log.warn("Drive comment send failed", {
      event: "drive.comments.send.failed", outcome: failure, error,
      ...(error instanceof DriveApiRequestError
        ? { httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}) }
        : {}),
    });
    if (failure === "unknown") {
      throw new Error("Google Drive did not confirm whether this was posted, and it may have " +
        "been. Approving it again first checks the file's comments, so it is not posted twice.",
        { cause: error });
    }
    host.attempts.delete(id);
    if (failure === "rateLimited") {
      throw new Error("Google Drive is limiting requests from this account. Approve it again in " +
        "a minute.", { cause: error });
    }
    throw new ActionApplyError(refusal(error));
  }
}

/** Refuses to drop a write a send may already have posted: approving it checks first. */
function refuseIfSent(host: DriveCommentsHost, id: number): void {
  if (host.attempts.get(id)) {
    throw new Error("This may already be posted on Google Drive; approve it to check.");
  }
}

function fileLine(builder: ActionDescriptionBuilder, payload: CommentTargetPayload): void {
  builder.inline("File", payload.fileId);
}

function parentLines(
  builder: ActionDescriptionBuilder, payload: DriveCommentActions["createReply" | "resolveComment"],
): void {
  builder.prose(`On ${plainInline(payload.parent.author)}'s comment:\n\n${
    quoteUntrusted(payload.parent.excerpt, PARENT_EXCERPT_CHARS)}`);
  fileLine(builder, payload);
  builder.inline("Comment", payload.commentId);
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
      let builder = buildDescription(
        `Post a comment on Google Drive file ${codeSpan(payload.fileId)} as the connected ` +
        `account. It is plain text, not attached to text in the file. ${EMAILED}`);
      fileLine(builder, payload);
      builder.verbatim("Comment", payload.content);
      return {
        title: "Comment on a Google Drive file", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "createComment", payload });
    },
    reject: async (_payload, host, ctx) => refuseIfSent(host, ctx.id),
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
      parentLines(builder, payload);
      builder.verbatim("Reply", payload.content);
      return {
        title: "Reply to a Google Drive comment", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "createReply", payload });
    },
    reject: async (_payload, host, ctx) => refuseIfSent(host, ctx.id),
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
      parentLines(builder, payload);
      if (payload.content !== undefined) builder.verbatim("Reply", payload.content);
      return {
        title: "Resolve a Google Drive comment", ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await post(host, ctx.id, { kind: "resolveComment", payload });
    },
    reject: async (_payload, host, ctx) => refuseIfSent(host, ctx.id),
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
