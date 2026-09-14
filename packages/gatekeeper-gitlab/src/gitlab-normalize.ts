// Pure helpers behind the GitLab gatekeeper: URL builders for the configured instance,
// normalization of REST responses into the agent-facing types, the filters and comparators the
// listing cursors apply, and the unified-patch reader. No runtime imports, so everything here
// runs under the package's Node vitest project.

import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type { GitDiffFile, GitDiffHunk } from "@gadgets/gatekeeper-kit/git-diff";
import type {
  GitLabActor,
  GitLabBranchRef,
  GitLabBranchSummary,
  GitLabCommitDetails,
  GitLabCommitIdentity,
  GitLabCommitSummary,
  GitLabDiffCommentTarget,
  GitLabDiscussionEntry,
  GitLabIssueDetails,
  GitLabIssueFilter,
  GitLabIssueSearch,
  GitLabIssueSummary,
  GitLabLabel,
  GitLabMergeRequestDetails,
  GitLabMergeRequestFilter,
  GitLabMergeRequestRevision,
  GitLabMergeRequestSearch,
  GitLabMergeRequestSummary,
  GitLabProjectMetadata,
  GitLabProjectRef,
  GitLabTagSummary,
} from "./types";
import type {
  GitLabBranchResponse,
  GitLabCommitResponse,
  GitLabDiffRefsResponse,
  GitLabDiffResponse,
  GitLabDiscussionResponse,
  GitLabIssueResponse,
  GitLabLabelResponse,
  GitLabLineRangeEndpoint,
  GitLabMergeRequestResponse,
  GitLabNoteResponse,
  GitLabPositionResponse,
  GitLabProjectResponse,
  GitLabSimpleUser,
  GitLabTagResponse,
} from "./gitlab-api";

// ---------------------------------------------------------------------------
// Instance URLs

/** The browser-facing instance origin, trailing slashes stripped. */
export function projectUrl(instanceUrl: string, projectPath: string): string {
  return `${instanceUrl}/${projectPath}`;
}

export function issueUrl(instanceUrl: string, projectPath: string, id: string): string {
  return `${projectUrl(instanceUrl, projectPath)}/-/issues/${id}`;
}

export function mergeRequestUrl(instanceUrl: string, projectPath: string, id: string): string {
  return `${projectUrl(instanceUrl, projectPath)}/-/merge_requests/${id}`;
}

export function commitUrl(instanceUrl: string, projectPath: string, sha: GitOid): string {
  return `${projectUrl(instanceUrl, projectPath)}/-/commit/${sha}`;
}

export function userUrl(instanceUrl: string, username: string): string {
  return `${instanceUrl}/${username}`;
}

/** The namespace part of a full project path (`group/sub` of `group/sub/project`). */
export function namespaceOf(projectPath: string): string {
  const slash = projectPath.lastIndexOf("/");
  return slash === -1 ? "" : projectPath.slice(0, slash);
}

/**
 * Build a `GitLabProjectRef` from a path alone (the project name defaults to the last path
 * segment; `getMetadata()` reports the display name from the API).
 */
export function projectRef(instanceUrl: string, projectPath: string, name?: string): GitLabProjectRef {
  return {
    path: projectPath,
    name: name ?? projectPath.slice(projectPath.lastIndexOf("/") + 1),
    namespace: namespaceOf(projectPath),
    url: projectUrl(instanceUrl, projectPath),
  };
}

/**
 * Parse a GitLab web URL into its project path and, when present, the issue or merge request
 * it names. GitLab separates the project path from everything else with `/-/`, which is what
 * makes nested namespaces unambiguous. Returns null for URLs on another origin or with too few
 * path segments to name a project.
 */
export function parseResourceUrl(instanceUrl: string, url: string):
    | { projectPath: string; kind: "project" }
    | { projectPath: string; kind: "issue" | "mergeRequest"; iid: number }
    | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(instanceUrl).origin) return null;
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  const [projectPath, rest] = splitOnDash(path);
  const segments = projectPath.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some(s => s === "-")) return null;
  const project = segments.join("/").replace(/\.git$/, "");
  if (rest === undefined) return { projectPath: project, kind: "project" };
  // The issues and merge requests list pages (`/-/issues`, `/-/merge_requests?state=opened`) are
  // the project, like every other `/-/` route (tree, commits, pipelines, ...). A route that names
  // an item must name it well: `/-/issues/abc` is refused rather than read as the whole project,
  // which the URL did not ask for.
  const route = /^(issues|merge_requests)\/([^/]+)(?:\/.*)?$/.exec(rest);
  if (!route) return { projectPath: project, kind: "project" };
  if (!/^\d+$/.test(route[2])) return null;
  return {
    projectPath: project,
    kind: route[1] === "issues" ? "issue" : "mergeRequest",
    iid: Number(route[2]),
  };
}

function splitOnDash(path: string): [string, string | undefined] {
  const marker = path.indexOf("/-/");
  if (marker === -1) return [path, undefined];
  return [path.slice(0, marker), path.slice(marker + 3)];
}

// ---------------------------------------------------------------------------
// Actors, labels, dates

export function actorFromUser(instanceUrl: string, user: GitLabSimpleUser | null | undefined): GitLabActor | null {
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.name ?? undefined,
    url: user.web_url ?? userUrl(instanceUrl, user.username),
    avatarUrl: user.avatar_url ?? undefined,
  };
}

export function actorsFromUsers(instanceUrl: string, users?: GitLabSimpleUser[] | null): GitLabActor[] {
  const result: GitLabActor[] = [];
  for (const user of users ?? []) {
    const actor = actorFromUser(instanceUrl, user);
    if (actor) result.push(actor);
  }
  return result;
}

export function actorFromUsername(instanceUrl: string, username: string): GitLabActor {
  return { username, url: userUrl(instanceUrl, username) };
}

/** GitLab returns label names by default and objects with `with_labels_details=true`. */
export function labelFromResponse(label: string | GitLabLabelResponse): GitLabLabel {
  if (typeof label === "string") return { name: label };
  return {
    name: label.name,
    color: label.color,
    description: label.description ?? undefined,
  };
}

export function dedupeLabels(labels: GitLabLabel[]): GitLabLabel[] {
  const seen = new Set<string>();
  const result: GitLabLabel[] = [];
  for (const label of labels) {
    const key = label.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(label);
    }
  }
  return result;
}

export function parseDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

export function textSnippet(markdown?: string, fallback = ""): string {
  const text = (markdown ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return fallback;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/** A stable cache-key fragment for a filter object. */
export function stableKey(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Projects

export function normalizeProjectMetadata(instanceUrl: string, response: GitLabProjectResponse): GitLabProjectMetadata {
  return {
    ...projectRef(instanceUrl, response.path_with_namespace, response.name),
    description: response.description ?? undefined,
    visibility: response.visibility,
    // An empty repository has no default branch; `main` is what GitLab will create on first push.
    defaultBranch: response.default_branch ?? "main",
  };
}

// ---------------------------------------------------------------------------
// Issues

export function normalizeIssueSummary(instanceUrl: string, projectPath: string, response: GitLabIssueResponse): GitLabIssueSummary {
  const id = String(response.iid);
  return {
    project: projectRef(instanceUrl, projectPath),
    id,
    url: issueUrl(instanceUrl, projectPath, id),
    title: response.title,
    state: response.state,
    labels: response.labels.map(labelFromResponse),
    author: actorFromUser(instanceUrl, response.author),
    assignees: actorsFromUsers(instanceUrl, response.assignees),
    createdAt: new Date(response.created_at),
    updatedAt: new Date(response.updated_at),
    closedAt: parseDate(response.closed_at),
    commentCount: response.user_notes_count,
    upvotes: response.upvotes,
  };
}

export function normalizeIssueDetails(instanceUrl: string, projectPath: string, response: GitLabIssueResponse): GitLabIssueDetails {
  return {
    ...normalizeIssueSummary(instanceUrl, projectPath, response),
    bodyMarkdown: response.description ?? "",
  };
}

export function summarizeIssueDetails(details: GitLabIssueDetails): GitLabIssueSummary {
  const { bodyMarkdown: _bodyMarkdown, ...summary } = details;
  return summary;
}

// ---------------------------------------------------------------------------
// Merge requests

/**
 * The gatekeeper's revision from GitLab's `diff_refs`. GitLab names the fields the other way
 * round from this API: its `base_sha` is the **merge base** and its `start_sha` the **target
 * branch head** when the diff was computed. Ours follow GitHub's meanings, so `baseSha` is the
 * target head and `mergeBaseSha` the merge base. Every use site goes through this one function.
 */
export function revisionFromDiffRefs(refs: GitLabDiffRefsResponse): GitLabMergeRequestRevision {
  return {
    baseSha: refs.start_sha,
    headSha: refs.head_sha,
    mergeBaseSha: refs.base_sha,
  };
}

/** `changes_count` is a string: `"12"`, or `"1000+"` when GitLab caps it. Empty until computed. */
export function parseChangesCount(value: string | null | undefined): { changedFiles?: number; changedFilesTruncated?: boolean } {
  if (!value) return {};
  const match = /^(\d+)(\+?)$/.exec(value);
  if (!match) return {};
  return {
    changedFiles: Number(match[1]),
    ...(match[2] ? { changedFilesTruncated: true } : {}),
  };
}

/**
 * Normalize a merge request summary. `sourceProject` is the source branch's project when it
 * differs from the target's (a merge request from a fork); the caller resolves it from
 * `source_project_id`, since the merge request object carries only the id.
 */
export function normalizeMergeRequestSummary(
  instanceUrl: string,
  projectPath: string,
  response: GitLabMergeRequestResponse,
  sourceProject?: GitLabProjectRef,
): GitLabMergeRequestSummary {
  const id = String(response.iid);
  const target = projectRef(instanceUrl, projectPath);
  const source: GitLabBranchRef = {
    branch: response.source_branch,
    sha: response.sha ?? "",
    project: sourceProject ?? target,
  };
  return {
    project: target,
    id,
    url: mergeRequestUrl(instanceUrl, projectPath, id),
    title: response.title,
    state: response.state,
    labels: response.labels.map(labelFromResponse),
    author: actorFromUser(instanceUrl, response.author),
    assignees: actorsFromUsers(instanceUrl, response.assignees),
    createdAt: new Date(response.created_at),
    updatedAt: new Date(response.updated_at),
    closedAt: parseDate(response.closed_at ?? response.merged_at),
    commentCount: response.user_notes_count,
    draft: response.draft,
    source,
    target: {
      branch: response.target_branch,
      // The target head at the time of the latest diff; empty until GitLab computes the diff.
      sha: response.diff_refs?.start_sha ?? "",
      project: target,
    },
  };
}

export function normalizeMergeRequestDetails(
  instanceUrl: string,
  projectPath: string,
  response: GitLabMergeRequestResponse,
  approvedBy: GitLabSimpleUser[],
  sourceProject?: GitLabProjectRef,
): GitLabMergeRequestDetails {
  return {
    ...normalizeMergeRequestSummary(instanceUrl, projectPath, response, sourceProject),
    bodyMarkdown: response.description ?? "",
    mergeStatus: response.detailed_merge_status ?? "unchecked",
    hasConflicts: response.has_conflicts ?? false,
    canMerge: response.user?.can_merge,
    reviewers: actorsFromUsers(instanceUrl, response.reviewers),
    approvedBy: actorsFromUsers(instanceUrl, approvedBy),
    ...parseChangesCount(response.changes_count),
  };
}

export function summarizeMergeRequestDetails(details: GitLabMergeRequestDetails): GitLabMergeRequestSummary {
  const {
    bodyMarkdown: _bodyMarkdown,
    mergeStatus: _mergeStatus,
    hasConflicts: _hasConflicts,
    canMerge: _canMerge,
    reviewers: _reviewers,
    approvedBy: _approvedBy,
    changedFiles: _changedFiles,
    changedFilesTruncated: _changedFilesTruncated,
    ...summary
  } = details;
  return summary;
}

/** Whether a title carries one of GitLab's recognised draft prefixes. */
export function hasDraftPrefix(title: string): boolean {
  return /^(?:\[draft\]|\(draft\)|draft:)/i.test(title.trimStart());
}

/** Add the `Draft: ` prefix unless the title already carries a recognised one. */
export function withDraftPrefix(title: string): string {
  return hasDraftPrefix(title) ? title : `Draft: ${title}`;
}

/**
 * The title a merge request is created with: `draft: true` adds the prefix; a title that already
 * carries one is a draft whatever the flag says, since GitLab derives draft status from the
 * title alone. Simulation and apply both read it from here, so what the agent is shown is what
 * GitLab will compute.
 */
export function mergeRequestCreateTitle(options: { title: string; draft?: boolean }): string {
  return options.draft ? withDraftPrefix(options.title) : options.title;
}

// ---------------------------------------------------------------------------
// Commits, branches, tags

function identityFromResponse(name?: string | null, email?: string | null, date?: string | null): GitLabCommitIdentity {
  return {
    name: name ?? undefined,
    email: email ?? undefined,
    date: date ? new Date(date) : undefined,
  };
}

export function normalizeCommitSummary(instanceUrl: string, projectPath: string, response: GitLabCommitResponse): GitLabCommitSummary {
  return {
    id: response.id,
    message: response.message,
    author: identityFromResponse(response.author_name, response.author_email, response.authored_date),
    committer: identityFromResponse(response.committer_name, response.committer_email, response.committed_date),
    parents: response.parent_ids ?? [],
    url: response.web_url ?? commitUrl(instanceUrl, projectPath, response.id),
  };
}

export function normalizeCommitDetails(instanceUrl: string, projectPath: string, response: GitLabCommitResponse): GitLabCommitDetails {
  return {
    ...normalizeCommitSummary(instanceUrl, projectPath, response),
    stats: response.stats
      ? { additions: response.stats.additions, deletions: response.stats.deletions, total: response.stats.total }
      : undefined,
  };
}

export function normalizeBranchSummary(response: GitLabBranchResponse): GitLabBranchSummary {
  return {
    name: response.name,
    headCommit: response.commit.id,
    protected: response.protected,
    default: response.default,
  };
}

/**
 * Whether a branch name satisfies GitLab's `search` for branches, as `GitRefsFinder#by_search`
 * applies it, so a branch a queued push creates is injected into a listing only where GitLab
 * would have listed it: case-insensitive; a plain term matches anywhere in the name; a term
 * containing `^`, `$` or `*` is a pattern in which the first `^` anchors the start, the first `$`
 * the end, and each `*` matches anything (the term is otherwise literal). The documentation
 * mentions `^term` and `term$` alone.
 */
export function branchNameMatchesSearch(name: string, search: string): boolean {
  const term = search.toLowerCase();
  const candidate = name.toLowerCase();
  if (!/[\^$*]/.test(term)) return candidate.includes(term);
  const source = term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    .replace("\\^", "^").replaceAll("\\*", ".*?").replace("\\$", "$");
  return new RegExp(source).test(candidate);
}

/** For an annotated tag `target` is the tag object; `commit.id` is always the peeled commit. */
export function normalizeTagSummary(response: GitLabTagResponse): GitLabTagSummary {
  return { name: response.name, commit: response.commit.id };
}

/** The commit ids a merge request summary carries: its source and target shas. */
export function commitIdsOfMergeRequestSummary(mr: { source: { sha: string }; target: { sha: string } }): GitOid[] {
  return [mr.source.sha, mr.target.sha];
}

// ---------------------------------------------------------------------------
// Notes and discussions

export type GitLabDiscussionCommentEntry = Extract<GitLabDiscussionEntry, { kind: "comment" }>;

/**
 * The diff position a discussion is anchored to, or null for a discussion on the issue or merge
 * request itself. The *discussion* is what is classified, by its root note: a reply inherits its
 * thread's anchor whether or not GitLab repeats `position` on the reply, so `readDiffThreads()`
 * and `readDiscussion()` -- which split the discussions between them -- agree on every note.
 */
export function diffAnchor(discussion: GitLabDiscussionResponse): GitLabPositionResponse | null {
  return discussion.notes[0]?.position ?? null;
}

export function discussionCommentFromNote(instanceUrl: string, noteableUrl: string, note: GitLabNoteResponse): GitLabDiscussionCommentEntry {
  return {
    kind: "comment",
    id: String(note.id),
    author: actorFromUser(instanceUrl, note.author),
    bodyMarkdown: note.body ?? "",
    createdAt: new Date(note.created_at),
    updatedAt: parseDate(note.updated_at),
    url: `${noteableUrl}#note_${note.id}`,
  };
}

/** Map a diff-note `position` to the agent-facing target. */
/**
 * A diff note's anchor as the agent-facing target. For a multi-line comment the selected range
 * is `line_range`, and *both* of its ends come from there -- the top-level `old_line`/`new_line`
 * are the line the note was left on, which GitLab does not keep equal to the range's end (its
 * own documentation example has a 10-11 range under a top-level line 27). A single-line note has
 * no range and the top-level pair is the line. This is the inverse of `#positionFor`, which
 * writes `line_range.start`/`end` from `startLine`/`line`.
 */
export function commentTargetFromPosition(position: GitLabPositionResponse): GitLabDiffCommentTarget {
  const path = position.new_path ?? position.old_path;
  if (position.position_type === "file") {
    return { path, subjectType: "file" };
  }
  const end = lineRangeEndpoint(position.line_range?.end) ?? {
    side: position.new_line != null ? "new" as const : "old" as const,
    line: (position.new_line != null ? position.new_line : position.old_line) ?? 1,
  };
  const target: GitLabDiffCommentTarget = { path, subjectType: "line", line: end.line, side: end.side };
  const start = lineRangeEndpoint(position.line_range?.start);
  if (start && (start.line !== end.line || start.side !== end.side)) {
    target.startLine = start.line;
    target.startSide = start.side;
  }
  return target;
}

/** One end of a `line_range`, on the side its `type` names (a `null` type is the new side). */
function lineRangeEndpoint(
  endpoint: GitLabLineRangeEndpoint | undefined,
): { side: "old" | "new"; line: number } | undefined {
  if (!endpoint) return undefined;
  const side = endpoint.type === "old" ? "old" : "new";
  const line = side === "new" ? endpoint.new_line : endpoint.old_line;
  return line == null ? undefined : { side, line };
}

// ---------------------------------------------------------------------------
// Diffs

/**
 * Read a unified patch into hunks, numbering each line on its old/new side. GitLab's `diff`
 * strings (and compare `diffs`) are unified patches without the `diff --git` header, so the
 * first line is already the `@@` hunk header.
 */
export function parsePatch(patch: string): GitDiffHunk[] {
  const lines = patch.split("\n");
  const hunks: GitDiffHunk[] = [];
  let currentHunk: GitDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ kind: "added", text: line.slice(1), newLineNumber: newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ kind: "removed", text: line.slice(1), oldLineNumber: oldLine });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({ kind: "context", text: line });
    } else {
      currentHunk.lines.push({
        kind: "context",
        text: line.startsWith(" ") ? line.slice(1) : line,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}

/** Count added and removed lines across hunks (GitLab's diff objects carry no counts). */
export function countPatchLines(hunks: GitDiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") additions += 1;
      else if (line.kind === "removed") deletions += 1;
    }
  }
  return { additions, deletions };
}

export function normalizeDiffFile(file: GitLabDiffResponse): GitDiffFile {
  const status = file.new_file ? "added"
    : file.deleted_file ? "removed"
    : file.renamed_file ? "renamed"
    : "modified";
  // GitLab excludes the patch for binary files (an empty `diff`) and for files over its diff
  // limits (`too_large`, or `collapsed` when it is fetchable separately).
  const omitted = !file.diff || file.too_large === true || file.collapsed === true;
  const hunks = omitted ? [] : parsePatch(file.diff);
  return {
    path: file.new_path ?? file.old_path,
    previousPath: file.renamed_file ? file.old_path : undefined,
    status,
    ...countPatchLines(hunks),
    ...(omitted ? { diffOmitted: true } : {}),
    hunks,
  };
}

// ---------------------------------------------------------------------------
// Filters and comparators (applied to overlaid items, consistent with the remote sort)

function matchesAllLabels(item: { labels: GitLabLabel[] }, labels?: string[]): boolean {
  if (!labels || labels.length === 0) return true;
  const available = new Set(item.labels.map(label => label.name.toLowerCase()));
  return labels.every(label => available.has(label.toLowerCase()));
}

export function issueMatchesFilter(item: GitLabIssueSummary, filter?: GitLabIssueFilter): boolean {
  if (!filter) return true;
  if (filter.state && filter.state !== "all" && item.state !== filter.state) return false;
  if (!matchesAllLabels(item, filter.labels)) return false;
  if (filter.author && item.author?.username !== filter.author) return false;
  if (filter.assignee && !item.assignees.some(a => a.username === filter.assignee)) return false;
  return true;
}

export function issueMatchesSearch(item: GitLabIssueDetails, query: GitLabIssueSearch): boolean {
  if (!issueMatchesFilter(item, query)) return false;
  const haystack = `${item.title}\n${item.bodyMarkdown}`.toLowerCase();
  return haystack.includes(query.text.toLowerCase());
}

export function mergeRequestMatchesFilter(item: GitLabMergeRequestSummary, filter?: GitLabMergeRequestFilter): boolean {
  if (!filter) return true;
  if (filter.state && filter.state !== "all" && item.state !== filter.state) return false;
  if (filter.sourceBranch && item.source.branch !== filter.sourceBranch) return false;
  if (filter.targetBranch && item.target.branch !== filter.targetBranch) return false;
  if (!matchesAllLabels(item, filter.labels)) return false;
  if (filter.author && item.author?.username !== filter.author) return false;
  if (filter.assignee && !item.assignees.some(a => a.username === filter.assignee)) return false;
  if (filter.draft !== undefined && item.draft !== filter.draft) return false;
  return true;
}

export function mergeRequestMatchesSearch(item: GitLabMergeRequestDetails, query: GitLabMergeRequestSearch): boolean {
  if (!mergeRequestMatchesFilter(item, query)) return false;
  const haystack = `${item.title}\n${item.bodyMarkdown}`.toLowerCase();
  return haystack.includes(query.text.toLowerCase());
}

/** GitLab's `order_by`/`sort` for an issue listing; `popularity` (upvotes) has no local proxy. */
export function issueOrder(filter?: GitLabIssueFilter): { orderBy: "created_at" | "updated_at" | "popularity"; sort: "asc" | "desc" } {
  const orderBy = filter?.sort === "updated" ? "updated_at" : filter?.sort === "popularity" ? "popularity" : "created_at";
  return { orderBy, sort: filter?.direction ?? "desc" };
}

export function mergeRequestOrder(filter?: GitLabMergeRequestFilter): { orderBy: "created_at" | "updated_at"; sort: "asc" | "desc" } {
  return { orderBy: filter?.sort === "updated" ? "updated_at" : "created_at", sort: filter?.direction ?? "desc" };
}

/**
 * A comparator consistent with the remote sort, for merging injected (touched/provisional)
 * items into a streamed listing at the right positions: the requested key in the requested
 * direction, ties broken by id descending whatever the direction, as GitLab's own listings break
 * them (`Issuable#sort_by_attribute` appends `id DESC` for pagination). Ties are the norm under
 * `popularity`, where most rows have no votes, so the tie-break decides most positions there.
 * Ids compare numerically when both are numbers; a provisional `~N` falls back to text order.
 */
export function issuableComparator<T extends { id: string; createdAt: Date; updatedAt: Date; upvotes?: number }>(
  sort: "created" | "updated" | "popularity" | undefined,
  direction: "asc" | "desc" | undefined,
): (a: T, b: T) => number {
  const factor = (direction ?? "desc") === "asc" ? 1 : -1;
  return (a, b) => {
    const delta = sort === "updated"
      ? a.updatedAt.getTime() - b.updatedAt.getTime()
      : sort === "popularity"
        ? (a.upvotes ?? 0) - (b.upvotes ?? 0)
        : a.createdAt.getTime() - b.createdAt.getTime();
    if (delta !== 0) return delta * factor;
    const [na, nb] = [Number(a.id), Number(b.id)];
    return Number.isFinite(na) && Number.isFinite(nb) ? nb - na : b.id.localeCompare(a.id);
  };
}

// ---------------------------------------------------------------------------
// Diff positions for review comments

/** A diff line re-found in its hunks: both side counters, and which kind of line it is. */
export type DiffLinePosition = {
  oldLine: number;
  newLine: number;
  kind: "added" | "removed" | "context";
};

/**
 * Both side positions of a diff line, as GitLab's `line_code` wants them, and its kind, which
 * decides how the line is named in a `position`: GitLab's own diff walk keeps an old-side and a
 * new-side counter and stamps every line with both -- an added line carries the old counter it
 * sits after, a removed line the new counter -- so a line identified by one side's number is
 * re-found here by re-walking the hunks with both counters. Returns null when the line is not in
 * the diff.
 */
export function diffLinePositions(
  hunks: GitDiffHunk[], side: "old" | "new", line: number,
): DiffLinePosition | null {
  for (const hunk of hunks) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
    if (!match) continue;
    let oldPos = Number(match[1]);
    let newPos = Number(match[3]);
    for (const entry of hunk.lines) {
      if (entry.kind === "context" && entry.oldLineNumber === undefined) continue;  // "\ No newline" marker
      const positions = { oldLine: oldPos, newLine: newPos, kind: entry.kind };
      if (entry.kind === "added") {
        if (side === "new" && newPos === line) return positions;
        newPos += 1;
      } else if (entry.kind === "removed") {
        if (side === "old" && oldPos === line) return positions;
        oldPos += 1;
      } else {
        if ((side === "new" && newPos === line) || (side === "old" && oldPos === line)) return positions;
        oldPos += 1;
        newPos += 1;
      }
    }
  }
  return null;
}
