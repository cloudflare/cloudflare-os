/**
 * A GitLab project.
 *
 * A GitLab project is a Git repository *plus* issues, merge requests, etc. Projects live under
 * namespaces that may nest (`group/subgroup/project`); the project's `path` is always the full
 * path with its namespace.
 *
 * Git-level access works in terms of commit ids: use `listBranches()`, `listTags()`,
 * `listCommits()`, `resolveRef()`, or `getCommit()` to discover commit ids, then mount a commit
 * as a worktree (see the `createWorktree` tool) to read or edit the files it contains. The
 * repository's file *content* is not readable through this interface directly.
 */
export interface GitLabProject {
  /** Returns basic metadata about the project. */
  getMetadata(): Promise<GitLabProjectMetadata>;

  /**
   * Lists branches in this project.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listBranches(options?: GitLabBranchFilter): Promise<Cursor<GitLabBranchSummary>>;

  /**
   * Lists tags in this project.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listTags(options?: GitLabPageOptions): Promise<Cursor<GitLabTagSummary>>;

  /**
   * Resolves a ref to a full commit id, without fetching the commit's details.
   *
   * `ref` may be a full commit id, an unambiguously truncated commit id, a branch name, or a tag
   * name; it defaults to the default branch, so `resolveRef()` with no argument answers "what
   * commit is the project currently at?". Prefer it over `getCommit()` when all you need is the
   * commit id, e.g. to mount a worktree or to resolve a truncated id mentioned in a code
   * comment, a commit message, or a CI log.
   */
  resolveRef(ref?: string): Promise<string>;

  /**
   * Looks up a single commit.
   *
   * `ref` may be a full commit id, an unambiguously truncated commit id, a branch name, or a tag
   * name; it defaults to the default branch, whose latest commit is then returned. If you only
   * need the commit id, use `resolveRef()` instead.
   */
  getCommit(ref?: string): Promise<GitLabCommitDetails>;

  /**
   * Lists this project's commit history, newest first, starting from `options.ref` (the
   * default branch when omitted).
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listCommits(options?: GitLabCommitFilter): Promise<Cursor<GitLabCommitSummary>>;

  /**
   * Pushes a commit to a branch, setting the branch's head to `commitId` -- the way commits made
   * in a worktree get to GitLab. The branch is created if it does not exist.
   *
   * `commitId` must be a full 40-character commit id (e.g. the result of a worktree `commit()`),
   * and the commit's history must be locally available down to a commit that came from this
   * project -- which is automatic for commits authored in a worktree mounted from a commit of
   * this project.
   *
   * Without `force`, the push must be a fast-forward: the branch's current head must be an
   * ancestor of `commitId`. If the branch has moved past the head your work was based on, the
   * push fails with an error saying so; pull the new head and rebase, or pass `force: true` to
   * overwrite the branch (which may discard others' commits -- prefer rebasing). A push that
   * GitLab's protected-branch or push rules reject fails with GitLab's own reason.
   *
   * To open a merge request for newly pushed work: `push(branch, commitId)` to a new branch,
   * then `createMergeRequest({sourceBranch: branch, targetBranch: ...})` -- immediately is fine;
   * the merge request will reflect the pushed commits.
   */
  push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void>;

  /**
   * Creates a new issue in this project.
   *
   * The issue may not be created on GitLab immediately. While creation is pending, the
   * returned issue will have a provisional ID (e.g. `"~1"`) instead of a real GitLab
   * number. You can reference it in other content using `#~1` syntax; these references
   * are automatically rewritten to the real `#number` once the issue is created. The
   * returned object is fully functional in the meantime.
   */
  createIssue(options: GitLabCreateIssueOptions): Promise<GitLabIssue>;

  /**
   * Creates a new merge request in this project.
   *
   * The merge request may not be created on GitLab immediately. While creation is pending,
   * the returned merge request will have a provisional ID (e.g. `"~1"`) instead of a real
   * GitLab number. You can reference it in other content using `!~1` syntax; these
   * references are automatically rewritten to the real `!number` once the merge request is
   * created. The returned object is fully functional in the meantime.
   *
   * To create a merge request from a commit you made (e.g. in a worktree), first `push()` the
   * commit to a new branch, then create the merge request with that branch as `sourceBranch` --
   * the two calls may be made back to back. Both `sourceBranch` and `targetBranch` must name
   * branches that exist (or that you have just pushed); otherwise this call fails immediately.
   * Creating a second merge request for the same source and target branches fails.
   */
  createMergeRequest(options: GitLabCreateMergeRequestOptions): Promise<GitLabMergeRequest>;

  /** Opens a specific issue in this project by its ID. Accepts both real GitLab numbers
   *  (e.g. `"42"`) and provisional IDs (e.g. `"~1"`). */
  getIssue(id: string): Promise<GitLabIssue>;

  /** Opens a specific merge request in this project by its ID. Accepts both real GitLab
   *  numbers (e.g. `"42"`) and provisional IDs (e.g. `"~1"`). Issues and merge requests are
   *  numbered independently on GitLab: issue `#42` and merge request `!42` are unrelated. */
  getMergeRequest(id: string): Promise<GitLabMergeRequest>;

  /**
   * Lists issues in this project.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listIssues(options?: GitLabIssueFilter): Promise<Cursor<GitLabIssueSummary>>;

  /**
   * Searches issues in this project.
   *
   * `query.text` is matched against issue titles and descriptions; the remaining fields are
   * structured filters.
   */
  searchIssues(query: GitLabIssueSearch): Promise<Cursor<GitLabIssueSummary>>;

  /**
   * Lists merge requests in this project.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listMergeRequests(options?: GitLabMergeRequestFilter): Promise<Cursor<GitLabMergeRequestSummary>>;

  /**
   * Searches merge requests in this project.
   *
   * `query.text` is matched against merge request titles and descriptions; the remaining
   * fields are structured filters.
   */
  searchMergeRequests(query: GitLabMergeRequestSearch): Promise<Cursor<GitLabMergeRequestSummary>>;
}

/**
 * Operations shared by issues and merge requests: GitLab calls both "issuables", and they carry
 * the same title, description, labels, state, and discussion thread.
 */
export interface GitLabIssuable {
  /** Replaces the title. */
  setTitle(title: string): Promise<void>;

  /** Replaces the description (the body). */
  setBody(bodyMarkdown: string): Promise<void>;

  /** Adds one or more labels. A label that does not exist in the project is created. */
  addLabels(labels: string[]): Promise<void>;

  /** Removes one or more labels. */
  removeLabels(labels: string[]): Promise<void>;

  /** Closes the issue or merge request. A merged merge request cannot be closed or reopened. */
  close(): Promise<void>;

  /** Reopens the issue or merge request. */
  reopen(): Promise<void>;

  /**
   * Reads the discussion thread: the comments people have posted, oldest first.
   *
   * This excludes the description, which is returned by `getDetails()`, and GitLab's automatic
   * system notes ("added label", "mentioned in !12", ...). For merge requests it also excludes
   * comments anchored to the diff -- `GitLabMergeRequest.readDiffThreads()` provides those.
   */
  readDiscussion(options?: GitLabPageOptions): Promise<Cursor<GitLabDiscussionEntry>>;

  /** Posts a new Markdown comment to the discussion thread. */
  postComment(bodyMarkdown: string): Promise<void>;
}

/** A single GitLab issue. */
export interface GitLabIssue extends GitLabIssuable {
  /** Returns the current issue metadata and description. */
  getDetails(): Promise<GitLabIssueDetails>;
}

/** A merge request. This extends the shared issuable API with review-oriented operations. */
export interface GitLabMergeRequest extends GitLabIssuable {
  /** Returns the current merge request metadata and description. */
  getDetails(): Promise<GitLabMergeRequestDetails>;

  /**
   * Returns the merge request diff as changed files and hunks.
   *
   * The returned `revision` must be echoed back to `postReview()`. The returned
   * `files` cursor streams pages lazily using the merge request state observed
   * when `readDiff()` is called. If the merge request changes while the cursor is
   * being consumed, later pages may reflect those newer changes.
   */
  readDiff(options?: GitLabPageOptions): Promise<GitLabMergeRequestDiff>;

  /**
   * Reads the existing diff threads attached to the merge request: comments anchored to a
   * file or line of the diff, with their replies grouped under them.
   */
  readDiffThreads(options?: GitLabPageOptions): Promise<Cursor<GitLabDiffThread>>;

  /**
   * Posts a review: an optional summary comment plus any number of diff comments, published
   * together, with a decision.
   *
   * `review.revision` must come from a preceding `readDiff()` call; `"approve"` is refused if
   * the merge request's head has moved since then. A `"comment"` or `"requestChanges"` review
   * needs a summary or at least one diff comment (an `"approve"` with neither still approves).
   * On GitLab Free, `"requestChanges"` records your review state but does not block merging; on
   * Premium/Ultimate it does until you approve or the request is dismissed.
   */
  postReview(review: GitLabMergeRequestReviewDraft): Promise<void>;

  /**
   * Replies to an existing diff thread.
   *
   * `commentId` is the id of any comment in the thread (typically the first one, as returned
   * by `readDiffThreads()`). The reply is posted as a new comment in that thread.
   */
  replyToDiffComment(commentId: string, bodyMarkdown: string): Promise<void>;

  /** Marks a diff thread as resolved. `threadId` is a `GitLabDiffThread.id`. */
  resolveDiffThread(threadId: string): Promise<void>;

  /** Reopens a resolved diff thread. `threadId` is a `GitLabDiffThread.id`. */
  unresolveDiffThread(threadId: string): Promise<void>;

  /**
   * Lists the commits that make up this merge request, oldest first.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listCommits(options?: GitLabPageOptions): Promise<Cursor<GitLabCommitSummary>>;

  /**
   * Returns the commit id of the merge request's merge base: the common ancestor of its source
   * and target branches that its diff is computed against. To review the changes in a worktree,
   * mount the merge request's head commit and diff it against this commit.
   */
  getMergeBase(): Promise<string>;

  /**
   * Merges the merge request.
   *
   * Fails with GitLab's reason when the request is not mergeable -- for example unresolved
   * conflicts, missing approvals, unresolved threads, a draft title, or a pipeline that has not
   * passed (pipeline status is not exposed through this interface; check it in GitLab).
   */
  merge(options?: GitLabMergeRequestMergeOptions): Promise<void>;
}

/** Basic information about a GitLab user or bot that appears in issue or review metadata. */
export type GitLabActor = {
  username: string;
  displayName?: string;
  url: string;
  avatarUrl?: string;
}

/** A project identifier. */
export type GitLabProjectRef = {
  /** The full path including every namespace level, e.g. `"group/subgroup/project"`. */
  path: string;
  /** The project's own name (the last path segment's display name). */
  name: string;
  /** The namespace path the project lives under, e.g. `"group/subgroup"`. */
  namespace: string;
  /** The project's web page. */
  url: string;
}

/** Basic project metadata. */
export type GitLabProjectMetadata = GitLabProjectRef & {
  description?: string;
  visibility: "public" | "private" | "internal";
  /** Name of the project's default branch (e.g. `"main"`). */
  defaultBranch: string;
}

/** A GitLab label attached to an issue or merge request. */
export type GitLabLabel = {
  name: string;
  color?: string;
  description?: string;
}

/**
 * Identifies an issue or merge request within a project.
 *
 * The `id` is normally the GitLab issue or merge request number as a string (e.g. `"42"`) --
 * what GitLab writes as `#42` for an issue and `!42` for a merge request. However, issues and
 * merge requests may not be created on GitLab immediately. While creation is pending, the item
 * is assigned a **provisional ID** of the form `"~1"`, `"~2"`, etc. Once it is actually created
 * on GitLab, the provisional ID is replaced with the real number, and all `#~N` (issue) and
 * `!~N` (merge request) references in previously submitted content are automatically rewritten
 * to the real reference. The provisional ID remains usable as a lookup key even after the real
 * ID is assigned.
 */
export type GitLabIssueId = {
  project: GitLabProjectRef;
  /** The issue or merge request number. A numeric string like `"42"` for existing items, or
   *  a provisional ID like `"~1"` for items whose creation is still pending. */
  id: string;
  url: string;
}

/** Fields common to issue and merge request summaries. */
export type GitLabIssuableSummary = GitLabIssueId & {
  title: string;
  labels: GitLabLabel[];
  author: GitLabActor | null;
  assignees: GitLabActor[];
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
  commentCount: number;
}

/** A compact issue summary returned from list and search operations. */
export type GitLabIssueSummary = GitLabIssuableSummary & {
  state: GitLabIssueState;
  /** Thumbs-up reactions; what `sort: "popularity"` orders by. */
  upvotes: number;
}

/** Full issue details returned by `GitLabIssue.getDetails()`. */
export type GitLabIssueDetails = GitLabIssueSummary & {
  bodyMarkdown: string;
}

/** A branch reference in a merge request. */
export type GitLabBranchRef = {
  branch: string;
  /**
   * Commit id of the branch's head, or `""` where GitLab does not supply it: `target.sha` in
   * every `listMergeRequests()`/`searchMergeRequests()` row (only a single merge request read
   * carries it -- call `getMergeRequest(id).getDetails()`), and both refs of a merge request
   * whose creation is still awaiting approval.
   */
  sha: string;
  /** The project the branch lives in: differs from the merge request's own project for a
   *  merge request from a fork. */
  project: GitLabProjectRef;
}

/** A compact merge request summary returned from list and search operations. */
export type GitLabMergeRequestSummary = GitLabIssuableSummary & {
  state: GitLabMergeRequestState;
  /** Whether the merge request is marked as a draft (a `Draft:` title prefix). */
  draft: boolean;
  /** The branch containing the changes. */
  source: GitLabBranchRef;
  /** The branch the changes will be merged into. */
  target: GitLabBranchRef;
}

/** Full merge request details returned by `GitLabMergeRequest.getDetails()`. */
export type GitLabMergeRequestDetails = GitLabMergeRequestSummary & {
  bodyMarkdown: string;
  /**
   * GitLab's assessment of whether the merge request can merge right now: `"mergeable"` when
   * it can, otherwise the reason -- for example `"conflict"`, `"not_approved"`,
   * `"discussions_not_resolved"`, `"draft_status"`, `"need_rebase"`, `"ci_must_pass"`,
   * `"ci_still_running"`, `"checking"` (GitLab is still computing it), or `"not_open"`.
   */
  mergeStatus: string;
  /** Whether the source branch conflicts with the target branch. */
  hasConflicts: boolean;
  /** Whether you (the connected account) are allowed to merge it. */
  canMerge?: boolean;
  /** Users asked to review the merge request. */
  reviewers: GitLabActor[];
  /** Users who have approved the merge request. */
  approvedBy: GitLabActor[];
  /** Number of changed files, when GitLab has computed it. */
  changedFiles?: number;
  /** True when `changedFiles` is GitLab's display cap rather than the exact count. */
  changedFilesTruncated?: boolean;
}

/** A branch returned by `GitLabProject.listBranches()`. */
export type GitLabBranchSummary = {
  name: string;
  /** Commit id of the branch's current head. */
  headCommit: string;
  /** Whether the branch is protected (pushes are restricted by role). */
  protected: boolean;
  /** Whether this is the project's default branch. */
  default: boolean;
}

/** A tag returned by `GitLabProject.listTags()`. */
export type GitLabTagSummary = {
  name: string;
  /** Commit id the tag points at (for an annotated tag, the commit it annotates). */
  commit: string;
}

/** The author or committer of a commit, as recorded in the commit itself. */
export type GitLabCommitIdentity = {
  name?: string;
  email?: string;
  date?: Date;
}

/**
 * A commit, as returned from commit lookups and history enumeration.
 *
 * `id` is the commit's full git commit id. Commit ids may be used anywhere the system accepts
 * one -- most notably, a commit can be mounted as a worktree (see the `createWorktree` tool) to
 * read or edit the files it contains, and commit ids created on such a worktree can be passed
 * back into this gatekeeper's APIs.
 */
export type GitLabCommitSummary = {
  /** The full git commit id (40 hex digits). */
  id: string;
  /** The full commit message. The first line is conventionally a short summary. */
  message: string;
  /** Who wrote the change, per the commit itself. */
  author: GitLabCommitIdentity;
  /** Who created the commit, per the commit itself (differs from `author` after e.g. a rebase). */
  committer: GitLabCommitIdentity;
  /** Commit ids of this commit's parents: empty for a root commit, two or more for a merge. */
  parents: string[];
  /** The GitLab web page where this commit can be viewed in a browser. */
  url: string;
}

/** Full commit details returned by `GitLabProject.getCommit()`. */
export type GitLabCommitDetails = GitLabCommitSummary & {
  /** Line counts across the commit's whole diff, when GitLab reports them. */
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
}

/**
 * A pagination cursor.
 *
 * This is an RPC object. Call `next()` repeatedly on the same cursor to fetch
 * subsequent batches of results. `next()` returns `null` once exhausted. Dispose the
 * cursor when finished.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** Generic paging options for a cursor-backed result set. */
export type GitLabPageOptions = {
  /** Rows per `next()` page: a positive integer, at most 100. Defaults to 50. */
  resultsPerPage?: number;
}

/** Filters for listing issues. */
export type GitLabIssueFilter = GitLabPageOptions & {
  state?: GitLabIssueState | "all";
  /** Only issues carrying *all* of these labels. */
  labels?: string[];
  /** Author's username. */
  author?: string;
  /** Assignee's username. */
  assignee?: string;
  /** `popularity` orders by upvotes. Defaults to `created`. */
  sort?: "created" | "updated" | "popularity";
  direction?: "asc" | "desc";
}

/** Filters for searching issues. */
export type GitLabIssueSearch = GitLabIssueFilter & {
  text: string;
}

/** Filters for listing merge requests. */
export type GitLabMergeRequestFilter = GitLabPageOptions & {
  state?: GitLabMergeRequestState | "all";
  /** Filter by source branch name. */
  sourceBranch?: string;
  /** Filter by target branch name. */
  targetBranch?: string;
  /** Only merge requests carrying *all* of these labels. */
  labels?: string[];
  /** Author's username. */
  author?: string;
  /** Assignee's username. */
  assignee?: string;
  /** When set, return only drafts (`true`) or only non-drafts (`false`). */
  draft?: boolean;
  sort?: "created" | "updated";
  direction?: "asc" | "desc";
}

/** Filters for searching merge requests. */
export type GitLabMergeRequestSearch = GitLabMergeRequestFilter & {
  text: string;
}

/** Filters for listing branches. */
export type GitLabBranchFilter = GitLabPageOptions & {
  /** Only branches whose name contains this text; `^term` anchors at the start, `term$` at the end. */
  search?: string;
}

/** Filters for listing commit history. */
export type GitLabCommitFilter = GitLabPageOptions & {
  /**
   * Where to start listing from: a branch name, tag name, or commit id. History is enumerated
   * newest-first from here. Defaults to the project's default branch.
   */
  ref?: string;
  /** Only commits touching the given file or directory path. */
  path?: string;
  /** Only commits whose author name or email matches the given text. */
  author?: string;
  /** Only commits dated after this time. */
  since?: Date;
  /** Only commits dated before this time. */
  until?: Date;
}

/** The state of an issue. */
export type GitLabIssueState = "opened" | "closed";

/** The state of a merge request. `locked` is transient, while GitLab is merging it. */
export type GitLabMergeRequestState = "opened" | "closed" | "merged" | "locked";

/**
 * What a review says: `comment` publishes its comments and marks you as having reviewed;
 * `approve` also records your approval on the merge request; `requestChanges` records that you
 * want changes before it merges.
 */
export type GitLabReviewDecision = "comment" | "approve" | "requestChanges";

/**
 * A discussion entry from an issue or merge request conversation.
 *
 * This excludes the description, which is accessed via `getDetails()`.
 */
export type GitLabDiscussionEntry = {
  kind: "comment";
  id: string;
  author: GitLabActor | null;
  bodyMarkdown: string;
  createdAt: Date;
  updatedAt?: Date;
  url: string;
};

/** The side of a merge request diff. */
export type GitLabDiffSide = "old" | "new";

/** One changed file in a merge request diff. */
export type GitLabDiffFile = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  additions: number;
  deletions: number;
  /** True when the patch is not included (e.g. binary files, very large files or diffs). */
  diffOmitted?: boolean;
  hunks: GitLabDiffHunk[];
}

/** Identifies the specific revision of a merge request diff. */
export type GitLabMergeRequestRevision = {
  /** Commit id of the target branch's head when the diff was computed. Note that the diff is
   *  *not* computed against this commit -- see `mergeBaseSha`. */
  baseSha: string;
  /** Commit id of the merge request's head: the last commit in the merge request. */
  headSha: string;
  /** Commit id of the merge base -- the common ancestor of `headSha` and `baseSha` that the
   *  diff is computed against. To review the changes in a worktree, mount `headSha` and diff it
   *  against this commit. Omitted only when the merge base could not be determined. */
  mergeBaseSha?: string;
}

/** A merge request diff pinned to a specific revision. */
export type GitLabMergeRequestDiff = {
  revision: GitLabMergeRequestRevision;
  files: Cursor<GitLabDiffFile>;
}

/** One hunk inside a changed file. */
export type GitLabDiffHunk = {
  header: string;
  lines: GitLabDiffLine[];
}

/** One line inside a diff hunk. */
export type GitLabDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * A location in a merge request diff.
 *
 * Targets use file line numbers on the old or new side of the diff, so callers do not need to
 * work with GitLab's lower-level position encoding.
 */
export type GitLabDiffCommentTarget =
  | {
      path: string;
      subjectType: "file";
    }
  | {
      path: string;
      subjectType?: "line";
      line: number;
      side: GitLabDiffSide;
      startLine?: number;
      startSide?: GitLabDiffSide;
    };

/** One comment inside a diff thread. */
export type GitLabDiffThreadComment = {
  id: string;
  author: GitLabActor | null;
  bodyMarkdown: string;
  createdAt: Date;
  updatedAt?: Date;
  url: string;
}

/** A diff thread attached to one diff location. */
export type GitLabDiffThread = {
  id: string;
  target: GitLabDiffCommentTarget;
  /** True when the thread was left on an earlier revision of the diff than the current head.
   *  Omitted when this cannot be determined. */
  isOutdated?: boolean;
  isResolved: boolean;
  comments: GitLabDiffThreadComment[];
}

/** A single diff comment to include in a review submission. */
export type GitLabDraftDiffComment = {
  target: GitLabDiffCommentTarget;
  bodyMarkdown: string;
}

/** A full review to submit on a merge request. */
export type GitLabMergeRequestReviewDraft = {
  revision: GitLabMergeRequestRevision;
  decision: GitLabReviewDecision;
  /** A summary comment, posted alongside the diff comments. */
  bodyMarkdown?: string;
  diffComments?: GitLabDraftDiffComment[];
}

/** Options for creating a new issue. */
export type GitLabCreateIssueOptions = {
  title: string;
  bodyMarkdown?: string;
  /** Labels to apply; a label that does not exist in the project is created. */
  labels?: string[];
  /** Assignees' usernames. Fails if a username does not exist. GitLab Free allows a single
   *  assignee; multiple assignees require GitLab Premium or Ultimate. */
  assignees?: string[];
}

/** Options for creating a new merge request. */
export type GitLabCreateMergeRequestOptions = {
  title: string;
  /** The branch containing your changes. */
  sourceBranch: string;
  /** The branch you want to merge into. */
  targetBranch: string;
  bodyMarkdown?: string;
  /** Mark the merge request as a draft (GitLab shows this as a `Draft:` title prefix). */
  draft?: boolean;
  /** Delete the source branch when the merge request is merged. */
  removeSourceBranch?: boolean;
  /** Squash the commits into one when merging. Defaults to the project's setting. */
  squash?: boolean;
}

/** Options for merging a merge request. */
export type GitLabMergeRequestMergeOptions = {
  /** Squash the commits into one. Defaults to the merge request's setting; the project may
   *  require or forbid squashing regardless. */
  squash?: boolean;
  /** Delete the source branch after merging. */
  removeSourceBranch?: boolean;
  /** Custom message for the merge commit. */
  commitMessage?: string;
  /** Custom message for the squash commit, when squashing. */
  squashCommitMessage?: string;
  /** Expected head commit id of the merge request: the merge fails if the current head doesn't
   *  match, so nothing pushed since you looked is merged unreviewed. If omitted, the head at the
   *  time `merge()` was called is bound, and the approval names it. */
  expectedHeadSha?: string;
}
