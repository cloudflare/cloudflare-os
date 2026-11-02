// Pure helpers behind the GitLab gatekeeper: URL builders for the configured instance,
// normalization of REST responses into the agent-facing types, and the filters and comparators
// the listing cursors apply. No platform imports, so everything here runs under the package's
// Node vitest project.

import { applyCarriageReturns, stripAnsi } from "@gadgets/gatekeeper-kit/ci";
import { parseUnifiedPatch } from "@gadgets/gatekeeper-kit/git-diff";
import { stripTrailingSlashes, type GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitLabActor,
  GitLabBranchRef,
  GitLabBranchSummary,
  GitLabCiPhase,
  GitLabCommitCi,
  GitLabCommitDetails,
  GitLabCommitIdentity,
  GitLabCommitSummary,
  GitLabDiffCommentTarget,
  GitLabDiffFile,
  GitLabDiffHunk,
  GitLabDiscussionEntry,
  GitLabIssueDetails,
  GitLabIssueFilter,
  GitLabIssueSearch,
  GitLabIssueSummary,
  GitLabJobDetails,
  GitLabJobSummary,
  GitLabLabel,
  GitLabMergeRequestDetails,
  GitLabMergeRequestFilter,
  GitLabMergeRequestRevision,
  GitLabMergeRequestSearch,
  GitLabMergeRequestSummary,
  GitLabPipelineDetails,
  GitLabPipelineStatus,
  GitLabPipelineSummary,
  GitLabProjectMetadata,
  GitLabProjectRef,
  GitLabTagSummary,
  GitLabTestCase,
  GitLabTestReportSummary,
} from "./types";
import type {
  GitLabBranchResponse,
  GitLabCommitResponse,
  GitLabCommitStatusResponse,
  GitLabDiffRefsResponse,
  GitLabDiffResponse,
  GitLabDiscussionResponse,
  GitLabIssueResponse,
  GitLabJobResponse,
  GitLabLabelResponse,
  GitLabLineRangeEndpoint,
  GitLabMergeRequestResponse,
  GitLabNoteResponse,
  GitLabPipelineBasicResponse,
  GitLabPipelineResponse,
  GitLabPositionResponse,
  GitLabProjectResponse,
  GitLabSimpleUser,
  GitLabTagResponse,
  GitLabTestReportResponse,
  GitLabTestReportSummaryResponse,
} from "./gitlab-api";
import { VENDOR_ID } from "./gitlab-env";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.gitlab", vendorId: VENDOR_ID });

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
  const path = stripTrailingSlashes(parsed.pathname.replace(/^\/+/, ""));
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
    sha: response.sha ?? null,
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
      // The target head at the time of the latest diff. Only the single-MR read carries
      // `diff_refs`, and only once GitLab has computed the diff, so a listing row has none.
      sha: response.diff_refs?.start_sha ?? null,
      project: target,
    },
  };
}

/**
 * Normalize a merge request's details. `approvedBy` is null when GitLab would not answer the
 * approvals read, and the field is then omitted: an empty list would claim nobody approved.
 */
export function normalizeMergeRequestDetails(
  instanceUrl: string,
  projectPath: string,
  response: GitLabMergeRequestResponse,
  approvedBy: GitLabSimpleUser[] | null,
  sourceProject?: GitLabProjectRef,
): GitLabMergeRequestDetails {
  return {
    ...normalizeMergeRequestSummary(instanceUrl, projectPath, response, sourceProject),
    bodyMarkdown: response.description ?? "",
    mergeStatus: response.detailed_merge_status ?? "unchecked",
    hasConflicts: response.has_conflicts ?? false,
    canMerge: response.user?.can_merge,
    reviewers: actorsFromUsers(instanceUrl, response.reviewers),
    ...(approvedBy === null ? {} : { approvedBy: actorsFromUsers(instanceUrl, approvedBy) }),
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

/** The commit ids a merge request summary carries: its source and target shas, where known. */
export function commitIdsOfMergeRequestSummary(mr: { source: { sha: string | null }; target: { sha: string | null } }): GitOid[] {
  return [mr.source.sha, mr.target.sha].filter(sha => sha !== null);
}

// ---------------------------------------------------------------------------
// CI

/**
 * Every pipeline and job status GitLab documents (`doc/api/jobs.md#job-status-values`,
 * `doc/api/pipelines.md`), with whether it moves on by itself. `scheduled` (a timer),
 * `waiting_for_callback` (an external system), and `canceling` (`after_script` running) all finish
 * without anyone acting; `manual` waits for a person.
 */
const CI_PHASES: Record<Exclude<GitLabPipelineStatus, "unknown">, GitLabCiPhase> = {
  created: "active",
  waiting_for_resource: "active",
  preparing: "active",
  waiting_for_callback: "active",
  pending: "active",
  running: "active",
  canceling: "active",
  scheduled: "active",
  manual: "blocked",
  success: "done",
  failed: "done",
  canceled: "done",
  skipped: "done",
};

/**
 * A provider status as the agent-facing union. One GitLab adds later reads `"unknown"` -- blocked,
 * so a caller polling for completion stops rather than spins -- and is logged so the mapping can be
 * extended.
 */
export function ciStatus(value: string): GitLabPipelineStatus {
  if (Object.hasOwn(CI_PHASES, value)) return value as GitLabPipelineStatus;
  logger.warn("unrecognised GitLab CI status", { event: "ci.unknown_status", ciStatus: value });
  return "unknown";
}

/** Whether a pipeline or job moves on by itself; a status this mapping does not know waits, like `manual`. */
export function ciPhase(status: GitLabPipelineStatus): GitLabCiPhase {
  return status === "unknown" ? "blocked" : CI_PHASES[status];
}

/** `project` names the project the pipeline ran in when that is not the bound one (a fork's). */
export function normalizePipelineSummary(response: GitLabPipelineBasicResponse, project?: GitLabProjectRef): GitLabPipelineSummary {
  const status = ciStatus(response.status);
  return {
    id: String(response.id),
    status,
    phase: ciPhase(status),
    source: response.source,
    ref: response.ref,
    commitId: response.sha,
    url: response.web_url,
    createdAt: new Date(response.created_at),
    updatedAt: new Date(response.updated_at),
    ...(project === undefined ? {} : { project }),
  };
}

export function normalizePipelineDetails(instanceUrl: string, response: GitLabPipelineResponse): GitLabPipelineDetails {
  return {
    ...normalizePipelineSummary(response),
    startedAt: parseDate(response.started_at),
    finishedAt: parseDate(response.finished_at),
    durationSeconds: response.duration ?? undefined,
    configErrors: response.yaml_errors || undefined,
    user: actorFromUser(instanceUrl, response.user),
  };
}

/**
 * A job or trigger job as a `listJobs()` row. A trigger job's downstream pipeline is openable only
 * when it ran in the bound project (`boundProjectId`): a child pipeline, not a multi-project one.
 */
export function normalizeJobSummary(
  response: GitLabJobResponse, ...[kind, boundProjectId]: ["job"] | ["trigger", number]
): GitLabJobSummary {
  const status = ciStatus(response.status);
  const downstream = kind === "trigger" ? response.downstream_pipeline : null;
  return {
    id: String(response.id),
    name: response.name,
    stage: response.stage,
    status,
    phase: ciPhase(status),
    kind,
    allowFailure: response.allow_failure,
    failureReason: response.failure_reason ?? undefined,
    ...(downstream
      ? { downstream: downstream.project_id === boundProjectId
        ? { crossProject: false as const, pipelineId: String(downstream.id) }
        : { crossProject: true as const } }
      : {}),
    startedAt: parseDate(response.started_at),
    finishedAt: parseDate(response.finished_at),
    durationSeconds: response.duration ?? undefined,
    url: response.web_url,
  };
}

export function normalizeJobDetails(response: GitLabJobResponse): GitLabJobDetails {
  return {
    ...normalizeJobSummary(response, "job"),
    pipelineId: String(response.pipeline.id),
    commitId: response.commit?.id ?? response.pipeline.sha,
    ref: response.ref,
    runner: response.runner?.description || response.runner?.name || undefined,
  };
}

/**
 * An external system's status as a `listJobs()` row. The statuses API does not expose a stage;
 * GitLab files every posted status under its `external` stage (`GenericCommitStatus`). With no
 * `target_url` the row links to its pipeline, the nearest page that shows it.
 */
export function normalizeCommitStatus(response: GitLabCommitStatusResponse, pipelineUrl: string): GitLabJobSummary {
  const status = ciStatus(response.status);
  return {
    id: String(response.id),
    name: response.name,
    stage: "external",
    status,
    phase: ciPhase(status),
    kind: "status",
    allowFailure: response.allow_failure,
    description: response.description || undefined,
    targetUrl: response.target_url || undefined,
    startedAt: parseDate(response.started_at),
    finishedAt: parseDate(response.finished_at),
    url: response.target_url || pipelineUrl,
  };
}

/**
 * Whether a merge request's head pipeline ran for its head commit `headSha`, not an earlier head's.
 * A merged-results pipeline runs on a commit GitLab made by merging the head -- on the merge
 * request's `…/merge` ref, or `…/train` for a merge train -- and counts when that commit's parents
 * include the head; `parentsOf` reads them, and is asked only for such a pipeline. `null` (the
 * commit cannot be read) counts as not current.
 */
export async function pipelineIsForHead(
  pipeline: { sha: string; ref: string },
  headSha: string,
  mergeRequestIid: string,
  parentsOf: (sha: string) => Promise<string[] | null>,
): Promise<boolean> {
  if (pipeline.sha === headSha) return true;
  const prefix = `refs/merge-requests/${mergeRequestIid}/`;
  if (pipeline.ref !== `${prefix}merge` && pipeline.ref !== `${prefix}train`) return false;
  return (await parentsOf(pipeline.sha))?.includes(headSha) ?? false;
}

/** CI on a commit no pipeline can exist for yet, such as one only a queued push will deliver. */
export function queuedCommitCi(commitId: string): GitLabCommitCi {
  return { commitId, phase: "notStarted", pipeline: null };
}

/**
 * Where a project's CI configuration is, from `ci_config_path`: a file in the repository (empty
 * means GitLab's default `.gitlab-ci.yml`), or somewhere else -- `path@group/project` in another
 * project, or a remote URL -- which counts as present, since this project's tree cannot say.
 */
export function ciConfigLocation(ciConfigPath: string | null | undefined): { kind: "file"; path: string } | { kind: "elsewhere" } {
  const path = ciConfigPath?.trim() ?? "";
  if (path === "") return { kind: "file", path: ".gitlab-ci.yml" };
  if (path.includes("@") || /^https?:\/\//i.test(path)) return { kind: "elsewhere" };
  return { kind: "file", path: path.replace(/^\/+/, "") };
}

export function normalizeTestReportSummary(response: GitLabTestReportSummaryResponse): GitLabTestReportSummary {
  return {
    total: response.total.count,
    failed: response.total.failed,
    errored: response.total.error,
    skipped: response.total.skipped,
    suites: response.test_suites.map(suite => ({
      name: suite.name,
      total: suite.total_count,
      failed: suite.failed_count,
      errored: suite.error_count,
    })),
  };
}

/** How much of a failed test's recorded output `listFailedTests()` returns. */
export const TEST_OUTPUT_MAX_CHARS = 4096;
const TEST_OUTPUT_TRUNCATED = "\n… [output truncated]";

/**
 * The failed and errored cases of a test report, suite by suite. `output` joins what the report
 * recorded (`system_output` and `stack_trace`, each once), cut to `TEST_OUTPUT_MAX_CHARS`.
 */
export function failedTestCases(response: GitLabTestReportResponse): GitLabTestCase[] {
  const cases: GitLabTestCase[] = [];
  for (const suite of response.test_suites) {
    for (const testCase of suite.test_cases) {
      if (testCase.status !== "failed" && testCase.status !== "error") continue;
      const parts = [...new Set([testCase.system_output, testCase.stack_trace].filter(part => !!part?.trim()))];
      const output = parts.join("\n");
      cases.push({
        suite: suite.name,
        name: testCase.name,
        className: testCase.classname || undefined,
        file: testCase.file || undefined,
        status: testCase.status,
        output: output === "" ? undefined
          : output.length > TEST_OUTPUT_MAX_CHARS ? output.slice(0, TEST_OUTPUT_MAX_CHARS) + TEST_OUTPUT_TRUNCATED : output,
        durationSeconds: testCase.execution_time ?? undefined,
      });
    }
  }
  return cases;
}

const LOG_SECTION = /section_(start|end):\d+:([A-Za-z0-9_.-]+)(?:\[[^\]\r]*\])?\r?/g;

/**
 * One raw job-trace line as `readCiLog` keeps it, or null when it is markup only. Strips ANSI
 * escapes and carriage-return overwrites; a `section_start` marker becomes `▶ ` and the section's
 * heading (or its name when the heading is empty), and a line holding only `section_end` markers
 * is dropped. Everything else is kept verbatim.
 */
export function normalizeGitLabLogLine(line: string): string | null {
  // Section markers precede their heading's `\r`, so they are read before overwriting.
  const text = stripAnsi(line);
  const markers = text.includes("section_") ? [...text.matchAll(LOG_SECTION)] : [];
  if (markers.length === 0) return applyCarriageReturns(text);
  const start = markers.findLast(marker => marker[1] === "start");
  if (start === undefined) {
    const rest = applyCarriageReturns(text.replace(LOG_SECTION, ""));
    return rest === "" ? null : rest;
  }
  const heading = applyCarriageReturns(text.slice(start.index + start[0].length).replace(LOG_SECTION, "")).trim();
  return `▶ ${heading === "" ? start[2] : heading}`;
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

/**
 * A diff note's anchor as the agent-facing target. For a multi-line comment the selected range
 * is `line_range`, and *both* of its ends come from there -- the top-level `old_line`/`new_line`
 * are the line the note was left on, which GitLab does not keep equal to the range's end (its
 * own documentation example has a 10-11 range under a top-level line 27). A single-line note has
 * no range and the top-level pair is the line. This is the inverse of `#positionFor`, which
 * writes `line_range.start`/`end` from `startLine`/`line`. A note on an image is anchored to a
 * point in the picture (`x`/`y`), not to a line, so it is the file's: the agent-facing target
 * has no way to name a pixel, and inventing a line would point the agent at text that is not
 * there.
 */
export function commentTargetFromPosition(position: GitLabPositionResponse): GitLabDiffCommentTarget {
  const path = position.new_path ?? position.old_path;
  if (position.position_type === "file" || position.position_type === "image") {
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

/** Count added and removed lines across hunks (GitLab's diff objects carry no counts). */
export function countPatchLines(hunks: GitLabDiffHunk[]): { additions: number; deletions: number } {
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

export function normalizeDiffFile(file: GitLabDiffResponse): GitLabDiffFile {
  const status = file.new_file ? "added"
    : file.deleted_file ? "removed"
    : file.renamed_file ? "renamed"
    : "modified";
  // GitLab excludes the patch for binary files (an empty `diff`) and for files over its diff
  // limits (`too_large`, or `collapsed` when it is fetchable separately).
  const omitted = !file.diff || file.too_large === true || file.collapsed === true;
  const hunks = omitted ? [] : parseUnifiedPatch(file.diff);
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

/**
 * GitLab matches label titles exactly (`Issuables::LabelFilter`), save its special `None`
 * (unlabelled) and `Any` (labelled) filters, which it reads without regard to case.
 */
function matchesAllLabels(item: { labels: GitLabLabel[] }, labels?: string[]): boolean {
  if (!labels?.length) return true;
  const special = labels.map(label => label.toLowerCase());
  if (special.includes("none")) return item.labels.length === 0;
  if (special.includes("any")) return item.labels.length > 0;
  return labels.every(label => item.labels.some(({ name }) => name === label));
}

/** GitLab looks usernames up without regard to case (`User.by_username`), so its filters match that way. */
function isUser(actor: GitLabActor | null, username: string): boolean {
  return actor?.username.toLowerCase() === username.toLowerCase();
}

function matchesPeople(
  item: Pick<GitLabIssueSummary, "author" | "assignees">,
  { author, assignee }: Pick<GitLabIssueFilter, "author" | "assignee">,
): boolean {
  return (!author || isUser(item.author, author)) && (!assignee || item.assignees.some(actor => isUser(actor, assignee)));
}

export function issueMatchesFilter(item: GitLabIssueSummary, filter?: GitLabIssueFilter): boolean {
  if (!filter) return true;
  if (filter.state && filter.state !== "all" && item.state !== filter.state) return false;
  if (!matchesAllLabels(item, filter.labels)) return false;
  if (!matchesPeople(item, filter)) return false;
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
  if (!matchesPeople(item, filter)) return false;
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
 * Ids compare numerically; a provisional `~N` is newer than every real id, as its issue will be.
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
    const [ra, rb] = [idRank(a.id), idRank(b.id)];
    return rb[0] - ra[0] || rb[1] - ra[1];
  };
}

/** An id's rank for GitLab's `id DESC` tie-break: a provisional `~N` outranks every real id. */
function idRank(id: string): [number, number] {
  return id.startsWith("~") ? [1, Number(id.slice(1))] : [0, Number(id)];
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
  hunks: GitLabDiffHunk[], side: "old" | "new", line: number,
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
