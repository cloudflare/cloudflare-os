/**
 * A GitHub repository.
 *
 * A GitHub repo is a Git repo *plus* issues, pull requests, etc.
 *
 * Git-level access works in terms of commit ids: use `listBranches()`, `listTags()`,
 * `listCommits()`, `resolveRef()`, or `getCommit()` to discover commit ids, then mount a commit
 * as a worktree (see the `createWorktree` tool) to read or edit the files it contains. The
 * repository's file *content* is not readable through this interface directly.
 */
export interface GitHubRepo {
  /** Returns basic metadata about the repository. */
  getMetadata(): Promise<GitHubRepoMetadata>;

  /**
   * Lists branches in this repository.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listBranches(options?: GitHubBranchFilter): Promise<Cursor<GitHubBranchSummary>>;

  /**
   * Lists tags in this repository.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listTags(options?: GitHubPageOptions): Promise<Cursor<GitHubTagSummary>>;

  /**
   * Resolves a ref to a full commit id, without fetching the commit's details.
   *
   * `ref` may be a full commit id, an unambiguously truncated commit id, a branch name, or a tag
   * name; it defaults to the default branch, so `resolveRef()` with no argument answers "what
   * commit is the repository currently at?". This is much cheaper than `getCommit()` -- prefer
   * it when all you need is the commit id, e.g. to mount a worktree or to resolve a truncated
   * id mentioned in a code comment, a commit message, or a CI log.
   */
  resolveRef(ref?: string): Promise<string>;

  /**
   * Looks up a single commit.
   *
   * `ref` may be a full commit id, an unambiguously truncated commit id, a branch name, or a tag
   * name; it defaults to the default branch, whose latest commit is then returned. If you only
   * need the commit id, use `resolveRef()` instead, which is much cheaper.
   */
  getCommit(ref?: string): Promise<GitHubCommitDetails>;

  /**
   * Lists this repository's commit history, newest first, starting from `options.ref` (the
   * default branch when omitted).
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listCommits(options?: GitHubCommitFilter): Promise<Cursor<GitHubCommitSummary>>;

  /**
   * Pushes a commit to a branch, setting the branch's head to `commitId` -- the way commits made
   * in a worktree get to GitHub. The branch is created if it does not exist.
   *
   * `commitId` must be a full 40-character commit id (e.g. the result of a worktree `commit()`),
   * and the commit's history must be locally available down to a commit that came from this
   * repository -- which is automatic for commits authored in a worktree mounted from a commit of
   * this repository.
   *
   * Without `force`, the push must be a fast-forward: the branch's current head must be an
   * ancestor of `commitId`. If the branch has moved past the head your work was based on, the
   * push fails with an error saying so; pull the new head and rebase, or pass `force: true` to
   * overwrite the branch (which may discard others' commits -- prefer rebasing).
   *
   * To open a pull request for newly pushed work: `push(branch, commitId)` to a new branch, then
   * `createPullRequest({head: branch, base: ...})` -- immediately is fine; the pull request will
   * reflect the pushed commits.
   */
  push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void>;

  /**
   * Creates a new issue in this repository.
   *
   * The issue may not be created on GitHub immediately. While creation is pending, the
   * returned issue will have a provisional ID (e.g. `"~1"`) instead of a real GitHub
   * number. You can reference it in other content using `#~1` syntax; these references
   * are automatically rewritten to the real `#number` once the issue is created. The
   * returned object is fully functional in the meantime.
   */
  createIssue(options: GitHubCreateIssueOptions): Promise<GitHubIssue>;

  /**
   * Creates a new pull request in this repository.
   *
   * The pull request may not be created on GitHub immediately. While creation is pending,
   * the returned PR will have a provisional ID (e.g. `"~1"`) instead of a real GitHub
   * number. You can reference it in other content using `#~1` syntax; these references
   * are automatically rewritten to the real `#number` once the PR is created. The
   * returned object is fully functional in the meantime.
   *
   * To create a pull request from a commit you made (e.g. in a worktree), first `push()` the
   * commit to a new branch, then create the pull request with that branch as `head` -- the two
   * calls may be made back to back. Both `head` and `base` must name branches that exist (or
   * that you have just pushed); otherwise this call fails immediately.
   */
  createPullRequest(options: GitHubCreatePullRequestOptions): Promise<GitHubPullRequest>;

  /** Opens a specific issue in this repository by its ID. Throws if the ID refers to a
   *  pull request. Accepts both real GitHub numbers (e.g. `"42"`) and provisional IDs
   *  (e.g. `"~1"`). */
  getIssue(id: string): Promise<GitHubIssue>;

  /** Opens a specific pull request in this repository by its ID. Throws if the ID does
   *  not refer to a pull request. Accepts both real GitHub numbers (e.g. `"42"`) and
   *  provisional IDs (e.g. `"~1"`). */
  getPullRequest(id: string): Promise<GitHubPullRequest>;

  /**
   * Lists issues in this repository.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listIssues(options?: GitHubIssueFilter): Promise<Cursor<GitHubIssueSummary>>;

  /**
   * Searches issues in this repository.
   *
   * The search is limited to this repository. `query.text` is matched as a literal phrase;
   * search qualifiers in it are not interpreted. The remaining fields are structured filters.
   */
  searchIssues(query: GitHubIssueSearch): Promise<Cursor<GitHubIssueSummary>>;

  /**
   * Lists pull requests in this repository.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listPullRequests(options?: GitHubPullRequestFilter): Promise<Cursor<GitHubPullRequestSummary>>;

  /**
   * Searches pull requests in this repository.
   *
   * The search is limited to this repository. `query.text` is a plain-text search
   * string; the remaining fields are structured filters.
   */
  searchPullRequests(query: GitHubPullRequestSearch): Promise<Cursor<GitHubPullRequestSummary>>;
}

/** A single GitHub issue. */
export interface GitHubIssue {
  /** Returns the current issue metadata and body. */
  getDetails(): Promise<GitHubIssueDetails>;

  /** Replaces the issue title. */
  setTitle(title: string): Promise<void>;

  /** Replaces the issue or pull request body. */
  setBody(bodyMarkdown: string): Promise<void>;

  /** Adds one or more labels to the issue. */
  addLabels(labels: string[]): Promise<void>;

  /** Removes one or more labels from the issue. */
  removeLabels(labels: string[]): Promise<void>;

  /** Closes the issue or pull request. */
  close(reason?: "completed" | "notPlanned"): Promise<void>;

  /** Reopens the issue or pull request. */
  reopen(): Promise<void>;

  /**
   * Reads the issue discussion thread.
   *
   * This excludes the issue or pull request body, which is returned by `getDetails()`.
   * Pull requests may also include review entries here. Each review entry includes the
   * inline diff comments that were submitted as part of that review.
   * `GitHubPullRequest.readDiffThreads()` provides the full thread-oriented view
   * of diff discussions.
   */
  readDiscussion(options?: GitHubPageOptions): Promise<Cursor<GitHubDiscussionEntry>>;

  /** Posts a new Markdown comment to the discussion thread. */
  postComment(bodyMarkdown: string): Promise<void>;
}

/** A pull request. This extends the issue API with review-oriented metadata. */
export interface GitHubPullRequest extends GitHubIssue {
  /** Returns the current pull request metadata and body. */
  getDetails(): Promise<GitHubPullRequestDetails>;

  /**
   * Returns the pull request diff as changed files and hunks.
   *
   * The returned `revision` must be echoed back to `postReview()`. The returned
   * `files` cursor streams pages lazily using the pull request state observed
   * when `readDiff()` is called. If the pull request changes while the cursor is
   * being consumed, later pages may reflect those newer changes.
   */
  readDiff(options?: GitHubPageOptions): Promise<GitHubPullRequestDiff>;

  /**
   * Reads the existing inline diff threads attached to the pull request.
   *
   * Replies are grouped under their thread. Top-level review summaries remain part of
   * `readDiscussion()`.
   */
  readDiffThreads(options?: GitHubPageOptions): Promise<Cursor<GitHubDiffThread>>;

  /**
   * Posts a full pull request review.
   *
   * `review.revision` must come from a preceding `readDiff()` call. The gatekeeper maps
   * line-based targets to GitHub's lower-level review comment positions.
   */
  postReview(review: GitHubPullRequestReviewDraft): Promise<void>;

  /**
   * Replies to an existing diff comment thread.
   *
   * `commentId` is the id of any comment in the thread (typically the top-level one,
   * as returned by `readDiffThreads()`). The reply is posted as a new comment in that
   * thread.
   */
  replyToDiffComment(commentId: string, bodyMarkdown: string): Promise<void>;

  /**
   * Lists the commits that make up this pull request, oldest first.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listCommits(options?: GitHubPageOptions): Promise<Cursor<GitHubCommitSummary>>;

  /**
   * Returns the commit id of the pull request's merge base: the common ancestor of its head and
   * base branches that its diff is computed against. To review the changes in a worktree, mount
   * the pull request's head commit and diff it against this commit.
   */
  getMergeBase(): Promise<string>;

  /** Merges the pull request. */
  merge(options?: GitHubPullRequestMergeOptions): Promise<void>;
}

/** Basic information about a GitHub user or bot that appears in issue or review metadata. */
export type GitHubActor = {
  login: string;
  displayName?: string;
  url: string;
  avatarUrl?: string;
}

/** A repository identifier. */
export type GitHubRepoRef = {
  owner: string;
  name: string;
  fullName: string;
  url: string;
}

/** Basic repository metadata. */
export type GitHubRepoMetadata = GitHubRepoRef & {
  description?: string;
  visibility: "public" | "private" | "internal";
  /** Name of the repository's default branch (e.g. `"main"`). */
  defaultBranch: string;
}

/** A GitHub label attached to an issue or pull request. */
export type GitHubLabel = {
  name: string;
  color?: string;
  description?: string;
}

/**
 * Identifies an issue or pull request within a repository.
 *
 * The `id` is normally the GitHub issue or PR number as a string (e.g. `"42"`). However,
 * issues and pull requests may not be created on GitHub immediately. While creation is
 * pending, the issue is assigned a **provisional ID** of the form `"~1"`, `"~2"`, etc.
 * Once the issue is actually created on GitHub, the provisional ID is replaced with the
 * real numeric ID, and all `#~N` references in previously submitted content are
 * automatically rewritten to the real `#number`. The provisional ID remains usable as a
 * lookup key even after the real ID is assigned.
 */
export type GitHubIssueId = {
  repo: GitHubRepoRef;
  /** The issue or PR identifier. A numeric string like `"42"` for existing issues, or a
   *  provisional ID like `"~1"` for issues whose creation is still pending. */
  id: string;
  url: string;
}

/** A compact issue summary returned from list and search operations. */
export type GitHubIssueSummary = GitHubIssueId & {
  title: string;
  state: GitHubIssueState;
  labels: GitHubLabel[];
  author: GitHubActor | null;
  assignees: GitHubActor[];
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
  commentCount: number;
}

/** Full issue details returned by `GitHubIssue.getDetails()`. */
export type GitHubIssueDetails = GitHubIssueSummary & {
  bodyMarkdown: string;
}

/** A branch reference in a pull request. */
export type GitHubPullRequestBranchRef = {
  ref: string;
  sha: string;
  repo: GitHubRepoRef;
}

/** A compact pull request summary returned from list and search operations. */
export type GitHubPullRequestSummary = GitHubIssueSummary & {
  draft: boolean;
  merged: boolean;
  head: GitHubPullRequestBranchRef;
  base: GitHubPullRequestBranchRef;
}

/** Full pull request details returned by `GitHubPullRequest.getDetails()`. */
export type GitHubPullRequestDetails = GitHubIssueDetails & GitHubPullRequestSummary & {
  /** Whether the pull request can currently be merged. */
  mergeable?: boolean;
  /** Requested reviewers who have not yet submitted a review. */
  requestedReviewers: GitHubActor[];
  /** Number of commits in the pull request. */
  commits: number;
  /** Total lines added. */
  additions: number;
  /** Total lines deleted. */
  deletions: number;
  /** Number of changed files. */
  changedFiles: number;
}

/** A branch returned by `GitHubRepo.listBranches()`. */
export type GitHubBranchSummary = {
  name: string;
  /** Commit id of the branch's current head. */
  headCommit: string;
  /** Whether the branch is covered by a branch protection rule. */
  protected: boolean;
}

/** A tag returned by `GitHubRepo.listTags()`. */
export type GitHubTagSummary = {
  name: string;
  /** Commit id the tag points at. */
  commit: string;
}

/** The author or committer of a commit, as recorded in the commit itself. */
export type GitHubCommitIdentity = {
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
export type GitHubCommitSummary = {
  /** The full git commit id (40 hex digits). */
  id: string;
  /** The full commit message. The first line is conventionally a short summary. */
  message: string;
  /** Who wrote the change, per the commit itself. */
  author: GitHubCommitIdentity;
  /** Who created the commit, per the commit itself (differs from `author` after e.g. a rebase). */
  committer: GitHubCommitIdentity;
  /** The GitHub account of the author, when GitHub can determine one. */
  authorAccount: GitHubActor | null;
  /** Commit ids of this commit's parents: empty for a root commit, two or more for a merge. */
  parents: string[];
  /** The github.com web page where this commit can be viewed in a browser. */
  url: string;
}

/** Full commit details returned by `GitHubRepo.getCommit()`. */
export type GitHubCommitDetails = GitHubCommitSummary & {
  /** Line counts across the commit's whole diff, when GitHub reports them. */
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
export type GitHubPageOptions = {
  resultsPerPage?: number;
}

/** Filters for listing issues. */
export type GitHubIssueFilter = GitHubPageOptions & {
  state?: GitHubIssueState | "all";
  labels?: string[];
  author?: string;
  assignee?: string;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
}

/** Filters for searching issues. */
export type GitHubIssueSearch = GitHubIssueFilter & {
  text: string;
}

/** Filters for listing pull requests. */
export type GitHubPullRequestFilter = GitHubPageOptions & {
  state?: GitHubIssueState | "all";
  /** Filter by head branch, in the format `user:ref-name` or just `ref-name`. */
  head?: string;
  /** Filter by base branch name. */
  base?: string;
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
}

/** Filters for searching pull requests. */
export type GitHubPullRequestSearch = GitHubPageOptions & {
  text: string;
  state?: GitHubIssueState | "all";
  merged?: boolean;
  draft?: boolean;
  labels?: string[];
  author?: string;
  assignee?: string;
}

/** Filters for listing branches. */
export type GitHubBranchFilter = GitHubPageOptions & {
  /** When set, return only protected (`true`) or only unprotected (`false`) branches. */
  protected?: boolean;
}

/** Filters for listing commit history. */
export type GitHubCommitFilter = GitHubPageOptions & {
  /**
   * Where to start listing from: a branch name, tag name, or commit id. History is enumerated
   * newest-first from here. Defaults to the repository's default branch.
   */
  ref?: string;
  /** Only commits touching the given file or directory path. */
  path?: string;
  /** Only commits whose author matches the given GitHub login or email address. */
  author?: string;
  /** Only commits dated after this time. */
  since?: Date;
  /** Only commits dated before this time. */
  until?: Date;
}

export type GitHubIssueState = "open" | "closed";

export type GitHubReviewDecision = "comment" | "approve" | "requestChanges";

export type GitHubPullRequestMergeMethod = "merge" | "squash" | "rebase";

/**
 * A discussion entry from an issue or pull request conversation.
 *
 * This excludes the issue or pull request body, which is accessed via
 * `GitHubIssue.getDetails()`.
 */
export type GitHubDiscussionEntry =
  | {
      kind: "comment";
      id: string;
      author: GitHubActor | null;
      bodyMarkdown: string;
      createdAt: Date;
      updatedAt?: Date;
      url: string;
    }
  | {
      kind: "review";
      id: string;
      author: GitHubActor | null;
      bodyMarkdown: string;
      createdAt: Date;
      updatedAt?: Date;
      url: string;
      decision: GitHubReviewDecision;
      diffComments: GitHubSubmittedDiffComment[];
    };

/** The side of a pull request diff. */
export type GitHubDiffSide = "old" | "new";

/** One changed file in a pull request diff. */
export type GitHubPullRequestDiffFile = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  additions: number;
  deletions: number;
  /** True when the patch is not included (e.g. binary files, very large files or diffs). */
  diffOmitted?: boolean;
  hunks: GitHubPullRequestDiffHunk[];
}

/** Identifies the specific revision of a pull request diff. */
export type GitHubPullRequestRevision = {
  /** Commit id of the base branch's head. Note that the diff is *not* computed against this
   *  commit -- see `mergeBaseSha`. */
  baseSha: string;
  /** Commit id of the pull request's head: the last commit in the pull request. */
  headSha: string;
  /** Commit id of the merge base -- the common ancestor of `headSha` and `baseSha` that the
   *  diff is computed against. To review the changes in a worktree, mount `headSha` and diff it
   *  against this commit. Omitted only when the merge base could not be determined. */
  mergeBaseSha?: string;
}

/** A pull request diff pinned to a specific revision. */
export type GitHubPullRequestDiff = {
  revision: GitHubPullRequestRevision;
  files: Cursor<GitHubPullRequestDiffFile>;
}

/** One hunk inside a changed file. */
export type GitHubPullRequestDiffHunk = {
  header: string;
  lines: GitHubPullRequestDiffLine[];
}

/** One line inside a diff hunk. */
export type GitHubPullRequestDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * A location in a pull request diff.
 *
 * The gatekeeper uses file line numbers rather than GitHub's lower-level diff-position
 * integers, so callers do not need to count hunk offsets themselves.
 */
export type GitHubDiffCommentTarget =
  | {
      path: string;
      subjectType: "file";
    }
  | {
      path: string;
      subjectType?: "line";
      line: number;
      side: GitHubDiffSide;
      startLine?: number;
      startSide?: GitHubDiffSide;
    };

/**
 * An inline diff comment that was submitted as part of a specific pull request review.
 *
 * This appears nested under `GitHubDiscussionEntry` with `kind: "review"`.
 */
export type GitHubSubmittedDiffComment = {
  id: string;
  threadId?: string;
  target: GitHubDiffCommentTarget;
  author: GitHubActor | null;
  bodyMarkdown: string;
  createdAt: Date;
  updatedAt?: Date;
  url: string;
}

/** One comment inside a diff thread. */
export type GitHubDiffThreadComment = {
  id: string;
  /** The review this comment was originally submitted under, if any. */
  reviewId?: string;
  author: GitHubActor | null;
  bodyMarkdown: string;
  createdAt: Date;
  updatedAt?: Date;
  url: string;
}

/** A diff thread attached to one diff location. */
export type GitHubDiffThread = {
  id: string;
  target: GitHubDiffCommentTarget;
  isOutdated: boolean;
  isResolved?: boolean;
  comments: GitHubDiffThreadComment[];
}

/** A single diff comment to include in a review submission. */
export type GitHubDraftDiffComment = {
  target: GitHubDiffCommentTarget;
  bodyMarkdown: string;
}

/** A full review to submit on a pull request. */
export type GitHubPullRequestReviewDraft = {
  revision: GitHubPullRequestRevision;
  decision: GitHubReviewDecision;
  bodyMarkdown?: string;
  diffComments?: GitHubDraftDiffComment[];
}

/** Options for creating a new issue. */
export type GitHubCreateIssueOptions = {
  title: string;
  bodyMarkdown?: string;
  labels?: string[];
  assignees?: string[];
}

/** Options for creating a new pull request. */
export type GitHubCreatePullRequestOptions = {
  title: string;
  /** The branch containing your changes. */
  head: string;
  /** The branch you want to merge into. */
  base: string;
  bodyMarkdown?: string;
  draft?: boolean;
}

/** Options for merging a pull request. */
export type GitHubPullRequestMergeOptions = {
  method?: GitHubPullRequestMergeMethod;
  commitTitle?: string;
  commitMessage?: string;
  /** Expected HEAD SHA of the pull request. If provided, the merge will fail if the
   *  current HEAD doesn't match, preventing races with concurrent pushes. */
  expectedHeadSha?: string;
}
