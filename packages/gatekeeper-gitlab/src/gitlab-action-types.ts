// The queued-action records the GitLab gatekeeper stores, and the derived state it keeps beside
// them. Declared apart from the Durable Object so the read paths (which overlay pending actions
// onto remote data) and the write paths (which create and apply them) share one vocabulary.
// Same shape as gatekeeper-github's, with GitLab's names and options.

import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitLabCreateIssueOptions,
  GitLabCreateMergeRequestOptions,
  GitLabDraftDiffComment,
  GitLabIssueState,
  GitLabMergeRequestMergeOptions,
  GitLabMergeRequestReviewDraft,
} from "./types";

/** Issues and merge requests share the mutation vocabulary but are numbered independently. */
export type EntityKind = "issue" | "mergeRequest";

/** The REST path segment for a kind. */
export function apiKind(kind: EntityKind): "issues" | "merge_requests" {
  return kind === "issue" ? "issues" : "merge_requests";
}

/**
 * A provisional reference -- `#~N` names a queued issue, `!~N` a queued merge request -- matched
 * as a whole token: `#~1` is neither in `#~10` nor in `#~1a`.
 */
const PROVISIONAL_REFERENCE = /([#!])(~\d+)(?!\w)/g;

/** A provisional reference found in a text. */
export type ProvisionalReference = {
  kind: EntityKind;
  provisionalId: string;
  /** The reference as written, e.g. `!~2`. */
  text: string;
};

/** Replace each provisional reference in `text` with what `replace` returns for it. */
export function replaceProvisionalReferences(
  text: string, replace: (reference: ProvisionalReference) => string,
): string {
  return text.replace(PROVISIONAL_REFERENCE, (match, sigil: string, provisionalId: string) =>
    replace({ kind: sigil === "#" ? "issue" : "mergeRequest", provisionalId, text: match }));
}

/**
 * A line GitLab may run as a quick action: `/` in the first column, a name, then whitespace or the
 * line's end. GitLab's extractor (`lib/gitlab/quick_actions/extractor.rb`) matches only its known
 * names, all word characters, and skips code, HTML and quote blocks -- but which, by version:
 * current releases find paragraphs with a Markdown pipeline, 16.x scans one regex that knows only
 * column-one ``` fences, so a `~~~` fence hides a command from one and not the other. Matching
 * any name everywhere escapes some lines GitLab would leave alone, never one it would run. It
 * deletes every carriage return first, so one may sit anywhere in the name: `\r*` takes those
 * after the slash, `\s` those after a prefix of the name (enough, since the escape goes before
 * the slash).
 */
const QUICK_ACTION_LINE = /^\/(?=\r*\w+(?:\s|$))/gm;

/**
 * Escape every line of `text` that GitLab would run as a quick action -- `/approve`, `/move`,
 * `/clone` -- on the issue or merge request it is posted to, with the user's full authority and
 * whatever the approved action said. The added backslash renders as nothing in Markdown text; in
 * code and raw HTML, where it is literal, it shows.
 */
export function escapeQuickActions(text: string): string {
  return text.replace(QUICK_ACTION_LINE, "\\/");
}

export type StoredActionState = "staged" | "pending" | "approved" | "rejected";

/** Where a `postComment`/`replyToDiffComment` landed, so a revert can delete it. */
export type GitLabRevertInfo = {
  type: "note";
  kind: EntityKind;
  noteId: number;
};

type BaseAction = {
  approvalId: number;
  submittedAt: number;
  projectPath: string;
};

export type CreateIssueAction = BaseAction & {
  type: "createIssue";
  provisionalId: string;
  options: GitLabCreateIssueOptions;
  /** Resolved at prepare time from `options.assignees`, so apply cannot fail on a typo. */
  assigneeIds: number[];
};

export type CreateMergeRequestAction = BaseAction & {
  type: "createMergeRequest";
  provisionalId: string;
  options: GitLabCreateMergeRequestOptions;
  /** Resolved at prepare time from `options.assignees`, as for an issue. */
  assigneeIds: number[];
};

type BaseEntityAction = BaseAction & {
  targetKind: EntityKind;
  targetId: string;
};

export type SetTitleAction = BaseEntityAction & {
  type: "setTitle";
  title: string;
  previousTitle: string;
};

export type SetBodyAction = BaseEntityAction & {
  type: "setBody";
  bodyMarkdown: string;
  previousBodyMarkdown: string;
};

export type AddLabelsAction = BaseEntityAction & {
  type: "addLabels";
  labels: string[];
  previousLabels: string[];
};

export type RemoveLabelsAction = BaseEntityAction & {
  type: "removeLabels";
  labels: string[];
  previousLabels: string[];
};

export type ChangeStateAction = BaseEntityAction & {
  type: "changeState";
  state: GitLabIssueState;
  previousState: GitLabIssueState;
};

export type PostCommentAction = BaseEntityAction & {
  type: "postComment";
  bodyMarkdown: string;
  provisionalCommentId: string;
};

export type StoredDraftDiffComment = GitLabDraftDiffComment & {
  provisionalCommentId: string;
};

export type PostReviewAction = BaseAction & {
  type: "postReview";
  mergeRequestId: string;
  provisionalReviewId: string;
  review: Omit<GitLabMergeRequestReviewDraft, "diffComments"> & {
    diffComments?: StoredDraftDiffComment[];
  };
};

export type ReplyToDiffCommentAction = BaseAction & {
  type: "replyToDiffComment";
  mergeRequestId: string;
  commentId: string;
  bodyMarkdown: string;
  provisionalCommentId: string;
};

export type ResolveDiffThreadAction = BaseAction & {
  type: "resolveDiffThread";
  mergeRequestId: string;
  threadId: string;
  resolved: boolean;
  /** The thread's state when the action was queued, which a revert restores. */
  previouslyResolved: boolean;
};

export type MergeMergeRequestAction = BaseAction & {
  type: "mergeMergeRequest";
  mergeRequestId: string;
  options?: GitLabMergeRequestMergeOptions;
  /**
   * The source head the merge was approved against: the agent's `expectedHeadSha`, else the head
   * read at queue time. Sent as `sha`, so GitLab refuses (409) to merge commits that arrived
   * after approval. Always present: a merge whose head cannot be determined is refused at
   * prepare rather than queued unbound.
   */
  expectedHeadSha: string;
  /**
   * The source branch, when it is in this project (null for a fork's): the branch whose queued
   * pushes `expectedHeadSha` may name. Rejecting the push that would leave that head retires
   * this merge too, since it could only be refused -- unless the branch already has that head
   * (see `#rejectActionsStrandedByPush`).
   */
  sourceBranch: string | null;
};

/**
 * A queued git push (see `GitLabProject.push()`). The expected remote ref state is bound at queue
 * time: what the user approves is "move `branch` from `expectedOldSha` to `newSha`", not "move
 * `branch` from wherever it is by then" -- apply enforces `expectedOldSha` via receive-pack's
 * old-sha compare-and-swap, so a branch that moved between approval and apply fails cleanly
 * instead of being clobbered. `expectedOldSha` doubles as the revert target (`ZERO_OID` means
 * the push creates the branch, and revert deletes it).
 */
export type PushAction = BaseAction & {
  type: "push";
  branch: string;
  expectedOldSha: GitOid;
  newSha: GitOid;
  force: boolean;
};

export type GitLabAction =
  | CreateIssueAction
  | CreateMergeRequestAction
  | SetTitleAction
  | SetBodyAction
  | AddLabelsAction
  | RemoveLabelsAction
  | ChangeStateAction
  | PostCommentAction
  | PostReviewAction
  | ReplyToDiffCommentAction
  | ResolveDiffThreadAction
  | MergeMergeRequestAction
  | PushAction;

/**
 * The Markdown fields apply posts, rewriting `#~N` / `!~N` provisional references to real numbers
 * and escaping quick actions (see `#postedText`). Apply rewrites each as it builds its request
 * rather than reading this list, so the list must name every field apply posts: the reject cascade
 * reads it -- a text that would be rewritten is a dependency, so rejecting the referenced resource
 * retires the action that names it -- and so do the approval card's notes.
 */
export function referenceBearingTexts(action: GitLabAction): string[] {
  switch (action.type) {
    case "createIssue":
    case "createMergeRequest":
      return action.options.bodyMarkdown ? [action.options.bodyMarkdown] : [];
    case "setBody":
    case "postComment":
    case "replyToDiffComment":
      return [action.bodyMarkdown];
    case "postReview":
      return [
        ...(action.review.bodyMarkdown ? [action.review.bodyMarkdown] : []),
        ...(action.review.diffComments ?? []).map(comment => comment.bodyMarkdown),
      ];
    case "setTitle": case "addLabels": case "removeLabels": case "changeState":
    case "resolveDiffThread": case "mergeMergeRequest": case "push":
      return [];
  }
}

/**
 * Whether `text` names the provisional `#~N` (issue) or `!~N` (merge request) `provisionalId`,
 * as the rewrite reads references: whole tokens only, so `#~1` is not named by `#~10`.
 */
export function textReferences(text: string, kind: EntityKind, provisionalId: string): boolean {
  const sigil = kind === "issue" ? "#" : "!";
  return [...text.matchAll(PROVISIONAL_REFERENCE)].some(([, found, id]) => found === sigil && id === provisionalId);
}

/**
 * How far a review's apply has got, so that a retry resumes rather than repeats -- including a
 * step whose reply was lost, which GitLab carried out but the record never heard about. A step
 * GitLab could carry out unanswered records that it is under way first (`"approving"`,
 * `"creating"`), and a retry finds out what became of it before repeating it. The summary note
 * alone is not looked for: no search can tell its lost post from an earlier identical note.
 */
export type ReviewProgress = {
  /**
   * `approve`'s approval: `"approving"` while unanswered; `{ approvedAt }` once it landed --
   * GitLab's `approved_at` for it, or null where the instance does not report one -- so that a
   * discard takes back this approval and not a later one; or `"preexisting"`, an approval the
   * account already held, which a discard leaves alone.
   */
  approval?: "approving" | "preexisting" | { approvedAt: string | null };
  /** Each diff comment's draft, by index: `"creating"` while unanswered, then its id, then `"published"`. */
  comments?: Array<null | "creating" | number | "published">;
  /** A `requestChanges` review's `bulk_publish` -- its drafts and its reviewer state -- answered. */
  requestedChanges?: true;
  /** The summary note's id, once posted. */
  summary?: number;
};

export type StoredActionRecord = {
  action: GitLabAction;
  state: StoredActionState;
  appliedAt?: number;
  rejectedAt?: number;
  revertInfo?: GitLabRevertInfo;
  /** A review's steps so far: the one action GitLab makes multi-call. */
  progress?: ReviewProgress;
};

/** A provisional issue/MR: what kind it is and, once created, its real number. */
export type StoredProvisionalResource = {
  kind: EntityKind;
  realId?: string;
};

/** A cache entry: `generation` lets `#clearCaches` invalidate every entry with one counter bump. */
export type Cached<T> = {
  fetchedAt: number;
  value: T;
  generation: number;
};

