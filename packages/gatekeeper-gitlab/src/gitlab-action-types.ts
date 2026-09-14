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
};

export type MergeMergeRequestAction = BaseAction & {
  type: "mergeMergeRequest";
  mergeRequestId: string;
  options?: GitLabMergeRequestMergeOptions;
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

export type StoredActionRecord = {
  action: GitLabAction;
  state: StoredActionState;
  appliedAt?: number;
  rejectedAt?: number;
  revertInfo?: GitLabRevertInfo;
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

