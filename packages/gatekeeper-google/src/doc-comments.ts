/**
 * Comments on a directly bound Google Doc: the binding's own comment writes, queued under their own
 * kind and applied by the comment engine in drive-comments.ts, and the session side that lists the
 * Doc's comments and queues the writes.
 *
 * The binding's grant (`documents` and `drive.metadata.readonly`) reaches the Doc's comments
 * through the Docs API, not Drive's comment API, which it is refused (probed 2026-11-11): it lists
 * every thread, makes comments attached to text and suggestions, and replies to, resolves and
 * reopens any comment attached to text, someone else's too. It cannot make a comment attached to
 * no text, nor reply to one (made through Drive, or on the whole file): those take a Google Drive
 * binding to the file. Whether the account may comment comes from Drive's metadata.
 */

import type { ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import type { ActionKind, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { UNCREATED_FILE_ID } from "./creation";
import {
  docsFileInvisible, docsLacksScope, docsWriteFailure, type DocsCommentPost,
  type DocsCommentRecord, type GoogleDocReader, type GoogleDocsApi, type GoogleDocsDocument,
  type GoogleDocsTab,
} from "./docs-api";
import {
  isDriveCommentId, isInsufficientScope, type DriveApi, type DriveCommentRecord,
  type DriveReplyRecord,
} from "./drive-api";
import {
  checkSuggestion, composeComment, composeReply, composeResolve, locateQuote, requireQuote,
} from "./drive-comment-body";
import {
  ALREADY_RESOLVED, COMMENT_NOT_FOUND, commentDefinitions, commentParent, hasPendingResolve,
  isPendingCommentId, overlayPending, pendingComment, pendingCommentRefusal, pendingReply,
  pendingSuggestion, REPLY_RESOLVE_PENDING, RESOLVE_PENDING, shownFileName, toDriveComment,
  type CommentHost, type CommentTargetPayload, type CommentThreads, type DriveCommentActions,
  type DriveCommentQueue,
} from "./drive-comments";
import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";
import { GoogleApiError } from "./google-response";
import { driveResourceUrl } from "./resources";

/**
 * The one kind a bound Doc's comment writes are queued as, its own rather than Drive comments' so
 * that a rule trusting one binding's comments does not trust the other's.
 *
 * Every write of it is auto-approvable: it posts into the bound Doc and deletes nothing. Rule 2 of
 * the opt-out policy covers one case, a text that mentions someone, an address written after `@`
 * or `+`: Google emails that person the text, whether or not they can open the Doc. The verdict is
 * kept `true` there by the same decision as for Drive comments, the exception the policy lists. No
 * mention is looked for, and the text is sent as it was written.
 */
export const DOC_COMMENTS: ActionKind = { tag: "docComments", label: "Google Doc comments" };

/** What a request refused for a missing scope fails with: only reconnecting restores a grant. */
export const DOC_GRANT_MISSING = "This Google account no longer grants what this Doc's " +
  "comments need. Reconnect it in Workshop, then approve again.";

/** The refusal of every comment write, and the empty listing, of a Doc not created yet. */
export const DOC_NOT_CREATED = "This Google Doc is not created yet, so it has no text to " +
  "comment on. Comment once it is created.";

/** The refusal for an account that can only view the Doc. */
export const DOC_VIEW_ONLY = "The connected account can only view this Google Doc, and Google " +
  "shows a Doc's comments only to accounts that can comment on it, so they can be neither read " +
  "nor written here.";

/** The refusal when Drive does not say whether the account may comment. */
const DOC_COMMENT_UNKNOWN = "Google Drive did not say whether the connected account can comment " +
  "on this Doc, so nothing was queued. Reconnecting the Google account in Workshop may fix this.";

/** The refusal for quoted text that is only in an edit still awaiting approval. */
export const QUOTE_ONLY_PENDING = "That text is only in an edit waiting for approval, and a " +
  "comment or suggestion is placed on the Doc as Google has saved it. Quote text the Doc has " +
  "now, or try again once the edit is approved.";

/**
 * The refusal for a reply to, or a resolve of, a comment attached to no text. It ends with the URL
 * of the Drive connection that can answer it and nothing after it, so that the URL is copied whole.
 */
export function unanchoredRefusal(documentId: string): string {
  return "That comment is attached to no text in the Doc (it was made in Google Drive, or on the " +
    "whole file), and Google Docs takes replies only to comments attached to text. A Google " +
    "Drive connection to the file with read and write access can answer it. Request one with " +
    `this resource URL: ${driveResourceUrl({ kind: "driveFile", fileId: documentId, access: "write" })}`;
}

/** A thread no longer in the Doc's listing: deleted, as Google leaves deleted threads out. */
class CommentGoneError extends Error {}

/** A comment attached to no text, which this binding never posts (its writes require a quote). */
class UnanchoredCommentError extends Error {}

function toReply(post: DocsCommentPost): DriveReplyRecord {
  return {
    id: post.postId, content: post.content, author: post.author, createdTime: post.createTime,
    ...(post.updateTime === undefined ? {} : { modifiedTime: post.updateTime }),
    deleted: false,
    ...(post.action === undefined ? {} : { action: post.action }),
  };
}

/**
 * A Docs comment thread in Drive's shape, the one the comment engine and the agent's types use:
 * the same comment under the same ID. Its modification time is its latest post's, as Drive's is.
 */
export function toCommentRecord(thread: DocsCommentRecord): DriveCommentRecord {
  let { headPost } = thread;
  let modifiedTime = [headPost, ...thread.replies]
    .map(post => post.updateTime ?? post.createTime)
    .reduce((latest, time) => Date.parse(time) > Date.parse(latest) ? time : latest);
  return {
    id: thread.commentId,
    content: headPost.content,
    ...(thread.quote === undefined ? {} : { quotedText: thread.quote }),
    author: headPost.author,
    createdTime: headPost.createTime,
    modifiedTime,
    resolved: thread.resolved,
    deleted: false,
    replies: thread.replies.map(toReply),
  };
}

/** What Drive's metadata says of whether the account may comment on `fileId`. */
async function canComment(
  drive: Pick<DriveApi, "getScopeNodes">, fileId: string,
): Promise<boolean | undefined> {
  try {
    return (await drive.getScopeNodes([fileId]))[0]?.canComment;
  } catch (error) {
    if (isInsufficientScope(error)) throw new Error(DOC_GRANT_MISSING, { cause: error });
    throw error;
  }
}

/**
 * A bound Doc's comment threads: the Docs API for its one Doc, `documentId()`, read when an
 * action applies, and Drive's metadata for whether the account may comment on it.
 */
export function docsThreads(
  documentId: () => string,
  docs: Pick<GoogleDocsApi, "getCommentThreads" | "replyToComment">,
  drive: Pick<DriveApi, "getScopeNodes">,
): CommentThreads {
  let thread = async (fileId: string, commentId: string) =>
    (await docs.getCommentThreads(fileId)).find(candidate => candidate.commentId === commentId);
  return {
    via: "Google Docs",
    grantMissing: DOC_GRANT_MISSING,
    target: async payload => payload.fileId === documentId()
      ? { canComment: await canComment(drive, payload.fileId) } : undefined,
    comment: async (fileId, commentId) => {
      let found = await thread(fileId, commentId);
      return found && toCommentRecord(found);
    },
    // One read holds every thread; the look keeps those from around its send.
    postedComments: async fileId => (await docs.getCommentThreads(fileId)).map(toCommentRecord),
    replies: async (fileId, commentId) => {
      let found = await thread(fileId, commentId);
      if (!found) throw new CommentGoneError("The comment is no longer in the Doc.");
      return toCommentRecord(found).replies;
    },
    reply: (fileId, commentId, { content, resolve }) =>
      docs.replyToComment(fileId, commentId, content ?? "", resolve ? "RESOLVE" : undefined),
    createUnanchored: async () => {
      throw new UnanchoredCommentError(
        "A comment on a bound Google Doc must be attached to text in it.");
    },
    sighted: async fileId => await canComment(drive, fileId) === true,
    sendFailure: error => error instanceof UnanchoredCommentError ? "absent" : docsWriteFailure(error),
    refusal: error => {
      if (error instanceof UnanchoredCommentError) return error.message;
      if (docsFileInvisible(error)) {
        return "Google Docs no longer shows this Doc or comment to the connected account.";
      }
      let status = error instanceof GoogleApiError ? error.providerStatus : undefined;
      return `Google Docs refused this${status ? ` [${status}]` : ""}.`;
    },
    lacksScope: error => docsLacksScope(error) || isInsufficientScope(error),
    invisible: error => error instanceof CommentGoneError || docsFileInvisible(error),
  };
}

/** The declared comment writes of a directly bound Google Doc. */
export const DOC_COMMENT_ACTIONS = commentDefinitions<CommentHost>(DOC_COMMENTS, {
  file: "Google Doc", commentTitle: "Comment on a Google Doc", thread: "Google Doc",
}, host => host);

/**
 * The tab of `document` an operation named `operation` acts on: `tabId`, which may be omitted only
 * when the Doc has one tab, as for the binding's edits.
 */
export function docTab(
  document: GoogleDocsDocument, tabId: string | undefined, operation: string,
): GoogleDocsTab {
  if (tabId === undefined) {
    if (document.tabs.length !== 1) {
      throw new Error(`${operation}: tabId is required for documents with multiple tabs. ` +
        "Call listTabs() to choose a tab.");
    }
    return document.tabs[0];
  }
  let tab = document.tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(`${operation}: no tab with ID "${tabId}" exists in this document. ` +
      "Call listTabs() to refresh the tab list.");
  }
  return tab;
}

/** What a bound Doc's session needs to show and queue its comment writes. */
export type DocCommentQueue = Pick<DriveCommentQueue, "submit" | "undecided">;

/** What the session side of a bound Doc's comments reads, queues and authorizes through. */
export type DocCommentSessionDeps = {
  /** The bound Doc, or `UNCREATED_FILE_ID` for one not created yet. */
  documentId: string;
  docs: GoogleDocReader;
  drive: Pick<DriveApi, "getScopeNodes">;
  comments: DocCommentQueue;
  approvalQueue: ActionSubmitter;
  /** Authorizes a read, reporting the Doc as its subresource. */
  authorizeRead(description: Omit<ObservationDescription, "subresources">): Promise<void>;
  /** Whether `quote` is in tab `tabId` only once its pending edits are replayed. */
  onlyInPendingEdits(tabId: string, quote: string): Promise<boolean>;
};

/**
 * The session side of a bound Doc's comments: listing them with this binding's pending writes, and
 * queuing each write once it passes the checks a write of the binding can be held to now. Every
 * read of the Doc it makes is authorized, successful or not, as the binding's other reads are.
 */
export class DocCommentSession {
  #deps: DocCommentSessionDeps;

  constructor(deps: DocCommentSessionDeps) {
    this.#deps = deps;
  }

  async listComments(): Promise<DriveComment[]> {
    let { documentId, comments } = this.#deps;
    return this.#read({
      title: "List Google Doc comments",
      description: "Read the document's comments, their replies, and the text each is attached to.",
    }, () => comments.undecided(async pending => overlayPending(documentId,
      (await this.#threads()).map(thread => toDriveComment(toCommentRecord(thread))),
      pending, true).comments));
  }

  async comment(text: string, options: { quote: string; tabId?: string }): Promise<DriveComment> {
    this.#requireCreated();
    // Checked before the Doc is read; a comment attached through Docs has the Docs limit.
    let content = composeComment(text, true);
    let quoted = requireQuote(options.quote);
    await this.#requireCommentable();
    let { document, tab } = await this.#quotedTab(quoted, options.tabId, "comment", false);
    let payload: DriveCommentActions["createComment"] = {
      ...this.#target(document.title), content, anchor: { tabId: tab.tabId, text: quoted },
    };
    let id = await this.#submit("createComment", payload);
    return pendingComment(id, payload);
  }

  async suggestEdit(
    oldText: string, newText: string, options: { note?: string; tabId?: string } = {},
  ): Promise<DocSuggestion> {
    this.#requireCreated();
    let checked = checkSuggestion(oldText, newText, options.note);
    await this.#requireCommentable();
    let { document, tab } =
      await this.#quotedTab(checked.oldText, options.tabId, "suggestEdit", true);
    let payload: DriveCommentActions["suggestEdit"] = {
      ...this.#target(document.title), tabId: tab.tabId, ...checked,
    };
    let id = await this.#submit("suggestEdit", payload);
    return pendingSuggestion(id, payload);
  }

  async reply(commentId: string, text: string): Promise<DriveCommentReply> {
    this.#requireCreated();
    await this.#requirePostedCommentId(commentId);
    let content = composeReply(text, true);
    await this.#requireCommentable();
    // Before Google is asked for the comment, so that a resolve applied meanwhile is seen there.
    if (await this.#resolvePending(commentId)) throw new Error(REPLY_RESOLVE_PENDING);
    let { comment, title } = await this.#answered(commentId);
    let payload: DriveCommentActions["createReply"] = {
      ...this.#target(title), commentId, content, parent: await commentParent(comment),
      // Google reopens a resolved comment that is replied to (probed for Docs too).
      ...(comment.resolved ? { reopens: true as const } : {}),
    };
    let id = await this.#submit("createReply", payload);
    return pendingReply(id, { kind: "createReply", payload });
  }

  async resolve(commentId: string, text?: string): Promise<DriveCommentReply> {
    this.#requireCreated();
    await this.#requirePostedCommentId(commentId);
    let content = composeResolve(text, true);
    await this.#requireCommentable();
    if (await this.#resolvePending(commentId)) throw new Error(RESOLVE_PENDING);
    let { comment, title } = await this.#answered(commentId);
    // Google would accept another resolve of a resolved comment.
    if (comment.resolved) throw new Error(ALREADY_RESOLVED);
    let payload: DriveCommentActions["resolveComment"] = {
      ...this.#target(title), commentId, ...(content === undefined ? {} : { content }),
      parent: await commentParent(comment),
    };
    let id = await this.#submit("resolveComment", payload);
    return pendingReply(id, { kind: "resolveComment", payload });
  }

  /** Runs `body`, authorizing `description` once it has settled, whatever it did. */
  async #read<T>(
    description: Omit<ObservationDescription, "subresources">, body: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await body();
    } catch (error) {
      // An error says something of the Doc too.
      await this.#deps.authorizeRead(description);
      throw error;
    }
    await this.#deps.authorizeRead(description);
    return result;
  }

  /** The Doc's threads, refusing an account that may only view it in our words. */
  async #threads(): Promise<DocsCommentRecord[]> {
    let { documentId, docs, drive } = this.#deps;
    try {
      return await docs.getCommentThreads(documentId);
    } catch (error) {
      if (docsLacksScope(error)) throw new Error(DOC_GRANT_MISSING, { cause: error });
      // A viewer is refused the read as it is refused a Doc it cannot see: Drive tells them apart.
      if (docsFileInvisible(error) && await canComment(drive, documentId) === false) {
        throw new Error(DOC_VIEW_ONLY, { cause: error });
      }
      throw error;
    }
  }

  #requireCreated(): void {
    if (this.#deps.documentId === UNCREATED_FILE_ID) throw new Error(DOC_NOT_CREATED);
  }

  /** Refuses a write the connected account could not make: it may only view the Doc. */
  async #requireCommentable(): Promise<void> {
    let allowed = await canComment(this.#deps.drive, this.#deps.documentId);
    if (allowed === false) throw new Error(DOC_VIEW_ONLY);
    if (allowed !== true) throw new Error(DOC_COMMENT_UNKNOWN);
  }

  /**
   * Refuses a comment ID that is not one Google gave: a `pending:` ID, by whether its comment
   * still awaits approval, or anything that is not a comment ID at all.
   */
  async #requirePostedCommentId(commentId: string): Promise<void> {
    if (isPendingCommentId(commentId)) {
      throw new Error(await this.#deps.comments.undecided(
        async pending => pendingCommentRefusal(commentId, pending)));
    }
    if (!isDriveCommentId(commentId)) throw new Error("Not a Google Docs comment ID.");
  }

  #resolvePending(commentId: string): Promise<boolean> {
    let { documentId, comments } = this.#deps;
    return comments.undecided(async pending => hasPendingResolve(documentId, commentId, pending));
  }

  /**
   * The comment a reply or resolve answers, as Google has it now, with the Doc's title: refused
   * when it is gone, or attached to no text, which Google Docs takes no reply to.
   */
  async #answered(commentId: string): Promise<{ comment: DriveCommentRecord; title: string }> {
    let { documentId, docs } = this.#deps;
    return this.#read({
      title: "Read a Google Doc comment",
      description: "Read the comment a reply or resolve answers.",
    }, async () => {
      let thread = (await this.#threads()).find(candidate => candidate.commentId === commentId);
      if (!thread) throw new Error(COMMENT_NOT_FOUND);
      if (!thread.anchored) throw new Error(unanchoredRefusal(documentId));
      let { title } = await docs.getDocumentMetadata(documentId);
      return { comment: toCommentRecord(thread), title };
    });
  }

  /**
   * The saved Doc and its tab in which `quote` occurs exactly once; with `wholeChips`, as for text
   * a suggestion replaces, refused when it takes in part of a chip. Text only in an edit still
   * waiting for approval is refused as such.
   */
  async #quotedTab(
    quote: string, tabId: string | undefined, operation: string, wholeChips: boolean,
  ): Promise<{ document: GoogleDocsDocument; tab: GoogleDocsTab }> {
    let { documentId, docs, onlyInPendingEdits } = this.#deps;
    return this.#read({
      title: "Read Google Doc content",
      description: "Read the text of one tab of the document to find the quoted text.",
    }, async () => {
      let document = await docs.getDocument(documentId);
      let tab = docTab(document, tabId, operation);
      try {
        locateQuote(tab, quote, { wholeChips });
      } catch (error) {
        if (await onlyInPendingEdits(tab.tabId, quote)) {
          throw new Error(QUOTE_ONLY_PENDING, { cause: error });
        }
        throw error;
      }
      return { document, tab };
    });
  }

  #target(title: string): CommentTargetPayload {
    return {
      fileId: this.#deps.documentId, fileName: shownFileName(title),
      queuedAt: new Date().toISOString(),
    };
  }

  #submit<K extends keyof DriveCommentActions>(
    kind: K, payload: DriveCommentActions[K],
  ): Promise<number> {
    return this.#deps.comments.submit(this.#deps.approvalQueue, kind, payload);
  }
}
