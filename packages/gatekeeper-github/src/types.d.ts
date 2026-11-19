import type { RpcStub } from "cloudflare:workers";

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

  /**
   * Reports CI on one commit: the check runs (GitHub Actions jobs and other apps' checks) and
   * commit statuses reported on it, up to 1000 of them with `counts` covering all, and an overall
   * `state` and `phase`.
   *
   * `ref` is as for `getCommit()`, defaulting to the default branch; a branch you have pushed to
   * reads at the commit you pushed. Poll while `phase` is `"notStarted"` or `"active"`, e.g. every
   * 30 seconds; stop once it is `"blocked"` (an entry waits for a person: see its `url`) or
   * `"done"`. A commit nothing has reported on reads `"notStarted"` for its first 10 minutes as a
   * head when CI is expected (it has workflow files, or its parent had CI), and while a push of
   * it you made has not reached GitHub; otherwise `"done"` with `state: "none"` (no CI ran on
   * it). Checks that report later still appear.
   */
  getChecks(ref?: string): Promise<GitHubCommitChecks>;

  /**
   * Opens a check run in this repository. `id` is a `GitHubCheckRunSummary.id`, or the number at
   * the end of a check run URL (`https://github.com/<owner>/<repo>/runs/<id>`) or of an Actions
   * job URL (`.../actions/runs/<run>/job/<id>`). Commit statuses cannot be opened.
   */
  getCheckRun(id: string): Promise<GitHubCheckRun>;

  /**
   * Lists GitHub Actions workflow runs in this repository, newest first.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listWorkflowRuns(options?: GitHubWorkflowRunFilter): Promise<Cursor<GitHubWorkflowRunSummary>>;

  /**
   * Opens a GitHub Actions workflow run in this repository. `id` is a
   * `GitHubWorkflowRunSummary.id`, or the number in a run URL
   * (`https://github.com/<owner>/<repo>/actions/runs/<id>`).
   */
  getWorkflowRun(id: string): Promise<GitHubWorkflowRun>;

  /**
   * Have `hook.receiveEvent()` called with each event of the kinds in `options.events` (by
   * default, all of them) in this repository:
   * - `issue`: an issue was opened, closed, or reopened;
   * - `pullRequest`: a pull request was opened, closed, merged, reopened, marked ready for review,
   *   or pushed to;
   * - `comment`: a comment was posted on an issue or pull request, or on a pull request's diff;
   * - `review`: a pull request review was submitted with a verdict or a summary;
   * - `push`: a branch was pushed to, created, or deleted;
   * - `tag`: a tag was created, moved, or deleted. GitHub reports nothing when a push changes
   *   more than three tags at once.
   *
   * The connected account's own comments and reviews are never delivered. Every other event is,
   * whoever caused it, including the writes a hook queues once they are approved. The hook starts
   * disabled, and nothing is delivered until the user enables it. Every call creates a distinct
   * hook, so subscribe once for each set of events to watch.
   *
   * GitHub delivers the events to a webhook that enabling the hook adds to the repository, which
   * only the repository's admins may do: this throws unless the connected account is one, and if
   * this deployment has not configured GitHub hooks.
   *
   * `hook` must be a persistent stub that restores through a Gadget's `[restore]()` method: inside
   * the Gadget, create it with `this.ctx.restore(params)`; from `executeCode`, through the Gadget's
   * binding, as "Persistent Stubs and `ctx.restore()`" in your instructions describes. The
   * Gadget's `[restore]()` receives those `params` for every delivery, so they can tell its
   * subscriptions apart. The restored target is a separate object; pass it what it needs from
   * `[restore]()`, such as `this`, the Gadget.
   *
   * @example
   * // server.js
   * import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
   * export class Gadget extends DurableObject {
   *   async [restore](params) {
   *     if (params.type === "triage") return new Triage();
   *     throw new TypeError(`Unknown restore type: ${params.type}`);
   *   }
   * }
   * class Triage extends RpcTarget {
   *   async receiveEvent(event) {
   *     if (event.kind === "issue" && event.action === "opened" && /crash/i.test(event.info.title)) {
   *       await event.issue.addLabels(["bug"]);
   *     }
   *   }
   * }
   *
   * // executeCode, where `hook` is a persistent stub for the params `{ type: "triage" }`
   * await env.GITHUB_REPO.subscribe(hook, { events: ["issue"] });
   */
  subscribe(hook: RpcStub<GitHubEventHook>, options?: GitHubSubscribeOptions): Promise<void>;
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

  /**
   * As `GitHubRepo.subscribe()`, for this issue alone: its `issue` events and the `comment`s on
   * it (by default, both). Throws while the issue's creation is pending.
   */
  subscribe(hook: RpcStub<GitHubEventHook>, options?: GitHubSubscribeOptions): Promise<void>;
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

  /** Merges the pull request at its current head (counting your queued pushes); the merge is
   *  refused if new commits land on the pull request before it is applied. */
  merge(options?: GitHubPullRequestMergeOptions): Promise<void>;

  /**
   * Reports CI on one of this pull request's commits, by default its head (counting your queued
   * pushes), as `GitHubRepo.getChecks()` does, plus which checks the base branch requires before
   * merging. Poll while `phase` is `"notStarted"` or `"active"`; stop on `"blocked"` or `"done"`.
   *
   * `commitId` must be the current head or one of the pull request's commits as
   * `listCommits()` lists them; only its first 250 commits are listed, and commits a force push
   * replaced, or merge-queue commits, are not among them. Any other commit is refused.
   */
  getChecks(commitId?: string): Promise<GitHubPullRequestChecks>;

  /**
   * Opens a check run, as `GitHubRepo.getCheckRun()` does, provided it ran on a commit
   * `getChecks()` accepts; any other check run is refused.
   */
  getCheckRun(id: string): Promise<GitHubCheckRun>;

  /**
   * Lists the GitHub Actions workflow runs of the pull request's head commit, newest first.
   * Empty while that head is a push you have just made that GitHub has not received yet.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listWorkflowRuns(options?: GitHubPageOptions): Promise<Cursor<GitHubWorkflowRunSummary>>;

  /**
   * Opens a workflow run, as `GitHubRepo.getWorkflowRun()` does, provided it ran on a commit
   * `getChecks()` accepts; any other run is refused.
   */
  getWorkflowRun(id: string): Promise<GitHubWorkflowRun>;

  /**
   * As `GitHubRepo.subscribe()`, for this pull request alone: its `pullRequest` events, the
   * `comment`s on it and on its diff, and its `review`s (by default, all three). Throws while the
   * pull request's creation is pending.
   */
  subscribe(hook: RpcStub<GitHubEventHook>, options?: GitHubSubscribeOptions): Promise<void>;
}

/** A GitHub Actions workflow run: one run of one workflow on one commit. */
export interface GitHubWorkflowRun {
  /** Returns the run's current state. */
  getDetails(): Promise<GitHubWorkflowRunDetails>;

  /**
   * Lists the run's jobs, from its latest attempt by default or from `options.attempt`. Each job
   * opens with `getCheckRun(job.id)`, e.g. to read its log.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listJobs(options?: { attempt?: number } & GitHubPageOptions): Promise<Cursor<GitHubCheckRunSummary>>;
}

/** A check run: a GitHub Actions job, or a check reported by another app. */
export interface GitHubCheckRun {
  /** Returns the check run's current state and output. */
  getDetails(): Promise<GitHubCheckRunDetails>;

  /**
   * Lists the annotations the check run attached to files, such as compiler errors and test
   * failures.
   *
   * Results are streamed through the returned cursor. Call `next()` repeatedly on that
   * same cursor until it returns `null`.
   */
  listAnnotations(options?: GitHubPageOptions): Promise<Cursor<GitHubAnnotation>>;

  /**
   * Reads a GitHub Actions job's log, one page of numbered lines at a time.
   *
   * Without `fromLine`, returns the last `maxLines` lines (default 200, at most 2000): where a
   * failure usually is. With `fromLine`, returns lines from there on; continue from the last
   * line's `number + 1` until no lines come back. With `search` (a case-insensitive substring),
   * only matching lines are returned, the last `maxLines` of them, or those from `fromLine` on.
   * Colour codes and timestamps are removed, and each step starts with a `▶ <step name>` line.
   *
   * The log is readable once the job has finished: until then this returns no lines with
   * `complete: false`. A very long log keeps only its end: lines before `firstAvailableLine`
   * are not available. Throws for a check run that is not a GitHub Actions job (`getDetails()`
   * returns its output and `detailsUrl` instead), and once GitHub has deleted the log after the
   * repository's retention period.
   */
  readLog(options?: GitHubLogOptions): Promise<GitHubLogPage>;
}

/**
 * The outcome of a check, a commit status, a step, or a workflow run. `waiting` means held by a
 * deployment environment, for a reviewer or a wait timer; `actionRequired` means the check asks
 * a person to act, e.g. to approve a first-time contributor's run; `unknown` is a state this API
 * does not recognise.
 */
export type GitHubCheckState =
  | "queued" | "inProgress" | "waiting"
  | "success" | "failure" | "cancelled" | "timedOut" | "actionRequired"
  | "skipped" | "neutral" | "stale" | "startupFailure" | "unknown";

/**
 * Whether an item will keep moving on its own:
 * - `active`: queued, running, or on a timer -- poll again;
 * - `blocked`: waits for a person, e.g. a deployment reviewer -- see its `url`;
 * - `done`: finished, and changes only if it is re-run.
 */
export type GitHubCiPhase = "active" | "blocked" | "done";

/**
 * A commit's overall phase: `active` if any entry is, else `blocked` if any entry is, else
 * `done`. `notStarted` means nothing has reported yet but CI is expected to start soon: poll
 * again. A phase that would be `done` reads `active` while a GitHub Actions run of the commit
 * waits on its concurrency group, for up to an hour: such a run has no check runs to list until
 * it starts.
 */
export type GitHubCiRollupPhase = GitHubCiPhase | "notStarted";

/** CI on one commit, returned by `GitHubRepo.getChecks()`. */
export type GitHubCommitChecks = {
  commitId: string;
  /**
   * GitHub's combined verdict: `pending` while anything is unfinished, `expected` while a
   * required status has not reported, `none` when nothing has reported. With nothing else
   * unfinished, `expected` reads `phase: "active"` for 10 minutes after the commit became a head,
   * then `"blocked"`: a required status that has not reported by then needs someone to act.
   */
  state: "success" | "failure" | "pending" | "expected" | "none";
  phase: GitHubCiRollupPhase;
  /**
   * How many entries are in each state. Counts every entry, even past the first 1000; only the
   * listed ones when GitHub could not count them.
   */
  counts: Partial<Record<GitHubCheckState, number>>;
  /** The check runs and commit statuses, at most 1000 of them. */
  checks: GitHubCheckEntry[];
};

/**
 * CI on one of a pull request's commits, returned by `GitHubPullRequest.getChecks()`. While a
 * check the base branch requires has not reported, `state` is `expected` (unless something
 * failed) and a `done` phase reads `active`, for the first 10 minutes after the commit became a
 * head or, for the head, after the pull request was opened, whichever is later. After that a
 * required check that has not reported needs someone to act (its workflow's
 * path filters skip it, or the app that reports it is not installed), so the phase reads
 * `blocked`: report `missingRequired`.
 */
export type GitHubPullRequestChecks = Omit<GitHubCommitChecks, "checks"> & {
  /** Each entry, with whether the base branch requires it to pass before merging. */
  checks: (GitHubCheckEntry & { required: boolean })[];
  /**
   * Names of checks the base branch requires that have not reported on this commit; the pull
   * request cannot merge until they do, and while any is named the commit's `state` is
   * `expected` (or `failure`). Empty when the requirements are not visible to you, and when
   * some reported checks are not listed -- past 1000, or ones GitHub would not return -- since a
   * required one may be among them.
   */
  missingRequired: string[];
};

/** One entry of a commit's CI: a check run, or a commit status. */
export type GitHubCheckEntry = GitHubCheckRunSummary | GitHubStatusSummary;

/** A check run, which opens with `getCheckRun(id)`. */
export type GitHubCheckRunSummary = {
  kind: "checkRun";
  id: string;
  name: string;
  state: GitHubCheckState;
  /**
   * In `listJobs()` results, a `waiting` job always reads as `blocked`; `getChecks()` and
   * `getDetails()` tell a wait timer (`active`) from a reviewer (`blocked`).
   */
  phase: GitHubCiPhase;
  /** The app that reported it, e.g. `"GitHub Actions"`. */
  app: string;
  /** The workflow run a GitHub Actions job belongs to; open it with `getWorkflowRun(id)`. */
  workflowRun?: { id: string; name: string };
  startedAt?: Date;
  completedAt?: Date;
  /** The check run's page on github.com. */
  url: string;
  /** Where the app shows more detail, if it says. */
  detailsUrl?: string;
};

/** A commit status reported by an external service. Data only: it cannot be opened. */
export type GitHubStatusSummary = {
  kind: "status";
  context: string;
  state: GitHubCheckState;
  phase: GitHubCiPhase;
  description?: string;
  /** Where the service shows more detail, if it says. */
  targetUrl?: string;
  updatedAt: Date;
};

/** Full check run details returned by `GitHubCheckRun.getDetails()`. */
export type GitHubCheckRunDetails = GitHubCheckRunSummary & {
  /** The commit the check ran on. */
  commitId: string;
  title?: string;
  summaryMarkdown?: string;
  textMarkdown?: string;
  /** How many annotations `listAnnotations()` returns. */
  annotationCount: number;
  /** A GitHub Actions job's steps, in order. */
  steps?: { number: number; name: string; state: GitHubCheckState; phase: GitHubCiPhase }[];
  /**
   * Set while a `waiting` job is held by a deployment environment: whether a reviewer must
   * approve it on github.com, and when its wait timer, if any, runs out.
   */
  pendingDeployment?: { environment: string; needsReviewers: boolean; waitTimerEndsAt?: Date };
};

/** A check run's annotation on a file. */
export type GitHubAnnotation = {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  title?: string;
  message: string;
};

/**
 * A GitHub Actions workflow run. `phase` treats a `waiting` run as `blocked`: it is held by a
 * deployment environment, usually for a reviewer.
 */
export type GitHubWorkflowRunSummary = {
  id: string;
  /** The workflow's name. */
  name: string;
  /** What triggered it, e.g. `"push"` or `"pull_request"`. */
  event: string;
  branch?: string;
  commitId: string;
  state: GitHubCheckState;
  phase: GitHubCiPhase;
  /** 1 for the first run, 2 and up for re-runs. */
  attempt: number;
  createdAt: Date;
  updatedAt: Date;
  url: string;
};

/** Full workflow run details returned by `GitHubWorkflowRun.getDetails()`. */
export type GitHubWorkflowRunDetails = GitHubWorkflowRunSummary & {
  /** When the latest attempt started. */
  startedAt?: Date;
  actor: GitHubActor | null;
};

/** Filters for listing workflow runs. */
export type GitHubWorkflowRunFilter = GitHubPageOptions & {
  /**
   * Only runs whose head branch has this name. Pull requests from forks count too when their
   * branch has the same name, so for a branch's own history add `event: "push"`.
   */
  branch?: string;
  /** Only runs on this full commit id. */
  commitId?: string;
  /** Only runs triggered by this event, e.g. `"push"`. */
  event?: string;
  /**
   * Only runs in this state. `queued` asks GitHub for its `queued` runs only: runs still
   * `pending` (waiting on a concurrency group) or `requested` read as `queued` too but are not
   * listed by it; list without `state` to see them.
   */
  state?: Exclude<GitHubCheckState, "unknown">;
};

/** Options for `GitHubCheckRun.readLog()`. */
export type GitHubLogOptions = {
  /** The first line to return, counting from 1. */
  fromLine?: number;
  /** How many lines to return: default 200, at most 2000. */
  maxLines?: number;
  /** Return only lines containing this text, ignoring case. */
  search?: string;
};

/** One page of a job's log. */
export type GitHubLogPage = {
  lines: { number: number; text: string }[];
  /** How many lines the log has. */
  totalLines: number;
  /** The first line that can be read: 1, unless a very long log kept only its end. */
  firstAvailableLine: number;
  /** Whether the job has finished, so the log will not grow. */
  complete: boolean;
};

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
export type GitHubPullRequestSummary = Omit<GitHubIssueSummary, "commentCount"> & {
  /** Usually absent from list and search results: GitHub's pull request listing omits it. */
  commentCount?: number;
  draft: boolean;
  merged: boolean;
  head: GitHubPullRequestBranchRef;
  base: GitHubPullRequestBranchRef;
}

/** Full pull request details returned by `GitHubPullRequest.getDetails()`. */
export type GitHubPullRequestDetails = GitHubIssueDetails & GitHubPullRequestSummary & {
  /** Whether the pull request can currently be merged. */
  mergeable?: boolean;
  /**
   * Why it can or cannot merge: `clean` (it can); `unstable` (it can, but checks are not all
   * passing); `hasHooks` (it can, with passing checks and pre-receive hooks); `blocked` (required
   * checks or reviews are missing); `behind` (the base branch must be merged in first); `dirty`
   * (it conflicts); `draft`; `unknown` (not computed yet: read again shortly; it also stays
   * `unknown` until commits you pushed to the pull request have reached GitHub).
   */
  mergeState: "clean" | "blocked" | "behind" | "dirty" | "unstable" | "hasHooks" | "draft" | "unknown";
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
 * subsequent batches of results. `next()` returns `null` once exhausted. A batch may be
 * empty when one call scanned many upstream rows without a match (e.g. a selective search);
 * that is not the end, so keep calling until `null`. Dispose the cursor when finished.
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
 * This appears nested under `GitHubDiscussionEntry` with `kind: "review"`, and as the `comment`
 * of a `GitHubCommentEvent` on a pull request's diff.
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
  /** The head SHA you reviewed. Queuing the merge fails if the pull request's current head
   *  (counting your queued pushes) differs. */
  expectedHeadSha?: string;
}

/** Implemented by a gadget to receive GitHub activity; see `GitHubRepo.subscribe()`. */
export interface GitHubEventHook {
  /**
   * Called with each event the hook watches for. Its capabilities (`issue`, `pullRequest` or
   * `repo`) can read and queue writes for approval, and are released when this call returns.
   * Return within a minute or two: after 4 minutes the call counts as failed and the event is
   * retried, while the first call may still be running. So an event may arrive more than once,
   * even twice at once, or out of order: key any work on `event.id` to keep it idempotent. One
   * this throws for is retried with backoff, eight attempts in all, and disabling the hook ends its
   * retries. An event can also be missed, as when GitHub can't reach this deployment for hours, so
   * a gadget that must see every change should also read the repository now and then.
   */
  receiveEvent(event: GitHubEvent): Promise<void>;
}

/** What `subscribe()` watches for. */
export type GitHubSubscribeOptions = {
  /** The kinds of event to deliver; by default, every kind the subscription can see. */
  events?: GitHubEventKind[];
}

/** One event delivered to a `GitHubEventHook`, told apart by `kind`. */
export type GitHubEvent =
  | GitHubIssueEvent
  | GitHubPullRequestEvent
  | GitHubCommentEvent
  | GitHubReviewEvent
  | GitHubPushEvent
  | GitHubTagEvent;

/** The kinds of `GitHubEvent`, which `GitHubSubscribeOptions.events` picks among. */
export type GitHubEventKind = GitHubEvent["kind"];

/** What every `GitHubEvent` carries. */
export type GitHubEventBase = {
  /** The event's id: the same for each delivery of it. */
  id: string;
  /** Who caused the event, when GitHub names someone. */
  actor: GitHubActor | null;
}

/** An issue was opened, closed, or reopened. */
export type GitHubIssueEvent = GitHubEventBase & {
  kind: "issue";
  action: "opened" | "closed" | "reopened";
  /** The issue as of the event. */
  info: GitHubIssueDetails;
  /** The issue, to read and to queue changes for approval. */
  issue: GitHubIssue;
}

/** A pull request was opened, closed, merged, reopened, marked ready for review, or pushed to. */
export type GitHubPullRequestEvent = GitHubEventBase & {
  kind: "pullRequest";
  /** `merged` is a close that merged it; `pushed` means its head branch moved, to `info.head.sha`. */
  action: "opened" | "closed" | "merged" | "reopened" | "readyForReview" | "pushed";
  /** The pull request as of the event. */
  info: GitHubPullRequestDetails;
  /** The pull request, to read and to queue changes for approval. */
  pullRequest: GitHubPullRequest;
}

/**
 * A comment was posted on an issue or a pull request, or on a pull request's diff. Exactly one
 * of `issue` and `pullRequest` is set, to what it was posted on.
 */
export type GitHubCommentEvent = GitHubEventBase & {
  kind: "comment";
  /** The issue or pull request it was posted on. */
  subject: GitHubEventSubject;
  /**
   * The comment, as `readDiscussion()` lists one: in the conversation (`kind: "comment"`), or
   * with a `target` on the diff, as a review's `diffComments` are.
   */
  comment: Extract<GitHubDiscussionEntry, { kind: "comment" }> | GitHubSubmittedDiffComment;
  issue?: GitHubIssue;
  pullRequest?: GitHubPullRequest;
}

/**
 * A pull request review was submitted with a verdict or a summary. Its diff comments arrive as
 * `comment` events, and a review with nothing else, such as a reply to a diff thread, is
 * delivered only as them.
 */
export type GitHubReviewEvent = GitHubEventBase & {
  kind: "review";
  /** The pull request reviewed. */
  subject: GitHubEventSubject;
  review: GitHubEventReview;
  pullRequest: GitHubPullRequest;
}

/** A branch was pushed to, created, or deleted. A tag's changes are `GitHubTagEvent`s. */
export type GitHubPushEvent = GitHubEventBase & {
  kind: "push";
  /** The branch's name, without `refs/heads/`. */
  branch: string;
  /** Its head commit before the push; absent when the push created it. */
  before?: string;
  /** Its head commit after the push; absent when the push deleted it. */
  after?: string;
  /** Whether the push rewrote the branch's history. */
  forced: boolean;
  /** The repository, to read what was pushed (e.g. `listCommits({ ref: after })`) and queue writes. */
  repo: GitHubRepo;
}

/**
 * A tag was created, moved, or deleted. `before` and `after` name what the tag pointed to: a
 * commit, or for an annotated tag, its tag object.
 */
export type GitHubTagEvent = GitHubEventBase & {
  kind: "tag";
  /** The tag's name, without `refs/tags/`. */
  tag: string;
  /** What it pointed to before the push; absent when the push created it. */
  before?: string;
  /** What it points to after the push; absent when the push deleted it. */
  after?: string;
  /** The repository, to read what the tag marks (e.g. `listCommits({ ref: tag })`) and queue writes. */
  repo: GitHubRepo;
}

/** The issue or pull request a comment or review event concerns. */
export type GitHubEventSubject = GitHubIssueId & {
  title: string;
}

/** The review a `GitHubReviewEvent` delivers. */
export type GitHubEventReview = {
  id: string;
  author: GitHubActor | null;
  decision: GitHubReviewDecision;
  bodyMarkdown: string;
  /** The head commit it reviewed. */
  commitId?: string;
  submittedAt?: Date;
  url: string;
}
