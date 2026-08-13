import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type ActionDescription,
  type AccountDescription,
  type Cursor,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GitHubApi,
  GitHubApiError,
  exchangeAuthCode,
  revokeOAuthGrant,
  type ConditionalRequestResult,
  type GitHubIssueCommentResponse,
  type GitHubIssueResponse,
  type GitHubLabelResponse,
  type GitHubPullFileResponse,
  type GitHubPullRequestResponse,
  type GitHubPullRequestReviewCommentResponse,
} from "./github-api";
import { assertIssueSearchResultsInRepo, buildIssueSearchQuery } from "./github-search";
import GITHUB_LOGO_SVG from "./github-logo.svg";
import type {
  GitHubActor,
  GitHubCreateIssueOptions,
  GitHubCreatePullRequestOptions,
  GitHubDiffCommentTarget,
  GitHubDiffThread,
  GitHubDiscussionEntry,
  GitHubDraftDiffComment,
  GitHubIssue,
  GitHubIssueDetails,
  GitHubIssueFilter,
  GitHubIssueSearch,
  GitHubIssueState,
  GitHubIssueSummary,
  GitHubLabel,
  GitHubPageOptions,
  GitHubPullRequest,
  GitHubPullRequestBranchRef,
  GitHubPullRequestDetails,
  GitHubPullRequestDiff,
  GitHubPullRequestDiffFile,
  GitHubPullRequestDiffHunk,
  GitHubPullRequestFilter,
  GitHubPullRequestMergeOptions,
  GitHubPullRequestReviewDraft,
  GitHubPullRequestRevision,
  GitHubPullRequestSearch,
  GitHubPullRequestSummary,
  GitHubRepo as GitHubRepoSession,
  GitHubRepoMetadata,
  GitHubRepoRef,
  GitHubReviewDecision,
} from "./types";
import TYPES_CODE from "./types.txt";
import {
  GitHubIssueConfiguratorUI,
  GitHubPullRequestConfiguratorUI,
  GitHubRepoConfiguratorUI,
} from "./github-configurators";
import GITHUB_ISSUE_CONFIGURATOR_HTML from "./generated/github-issue-configurator-ui.txt";
import GITHUB_PULL_REQUEST_CONFIGURATOR_HTML from "./generated/github-pull-request-configurator-ui.txt";
import GITHUB_REPO_CONFIGURATOR_HTML from "./generated/github-repo-configurator-ui.txt";
import { obsContext } from "./observability.js";

const VENDOR_ID = "github";

const logger = obsContext.createLogger({
  component: "gatekeeper.github", vendorId: VENDOR_ID,
});

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type ResourceKind = "repo" | "issue" | "pull";
type EntityKind = "issue" | "pull";

type GitHubGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  owner: string;
  repo: string;
  issueNumber?: number;
};

type Cached<T> = {
  fetchedAt: number;
  value: T;
  etag?: string;
  generation: number;
};

type CachedIssueSearchResult = {
  html_url: string;
  summary: GitHubIssueSummary;
};

type GitHubDiscussionCommentEntry = Extract<GitHubDiscussionEntry, { kind: "comment" }>;

type StoredCommentCacheState = {
  depth: number;
  freshness: number;
  exhausted: boolean;
  chunkSize?: number;
  ids: string[];
};

type StoredDiscussionCommentState = StoredCommentCacheState;

type StoredPullReviewCommentState = StoredCommentCacheState;

type StoredViewer = {
  actor: GitHubActor;
  fetchedAt: number;
};

type StoredProvisionalResource = {
  kind: EntityKind;
  realId?: string;
};

type StoredActionState = "staged" | "pending" | "approved" | "rejected";

type GitHubRevertInfo =
  | {
      type: "issueComment";
      commentId: number;
    }
  | {
      type: "reviewComment";
      commentId: number;
    };

type BaseAction = {
  approvalId: number;
  submittedAt: number;
  owner: string;
  repo: string;
};

type CreateIssueAction = BaseAction & {
  type: "createIssue";
  provisionalId: string;
  options: GitHubCreateIssueOptions;
};

type CreatePullRequestAction = BaseAction & {
  type: "createPullRequest";
  provisionalId: string;
  options: GitHubCreatePullRequestOptions;
};

type BaseEntityAction = BaseAction & {
  targetKind: EntityKind;
  targetId: string;
};

type SetTitleAction = BaseEntityAction & {
  type: "setTitle";
  title: string;
  previousTitle: string;
};

type SetBodyAction = BaseEntityAction & {
  type: "setBody";
  bodyMarkdown: string;
  previousBodyMarkdown: string;
};

type AddLabelsAction = BaseEntityAction & {
  type: "addLabels";
  labels: string[];
  previousLabels: string[];
};

type RemoveLabelsAction = BaseEntityAction & {
  type: "removeLabels";
  labels: string[];
  previousLabels: string[];
};

type ChangeStateAction = BaseEntityAction & {
  type: "changeState";
  state: GitHubIssueState;
  reason?: "completed" | "notPlanned";
  previousState: GitHubIssueState;
  previousReason?: "completed" | "notPlanned";
};

type PostCommentAction = BaseEntityAction & {
  type: "postComment";
  bodyMarkdown: string;
  provisionalCommentId: string;
};

type StoredDraftDiffComment = GitHubDraftDiffComment & {
  provisionalCommentId: string;
};

type PostReviewAction = BaseAction & {
  type: "postReview";
  pullId: string;
  provisionalReviewId: string;
  review: Omit<GitHubPullRequestReviewDraft, "diffComments"> & {
    diffComments?: StoredDraftDiffComment[];
  };
};

type ReplyToDiffCommentAction = BaseAction & {
  type: "replyToDiffComment";
  pullId: string;
  commentId: string;
  bodyMarkdown: string;
  provisionalCommentId: string;
};

type MergePullRequestAction = BaseAction & {
  type: "mergePullRequest";
  pullId: string;
  options?: GitHubPullRequestMergeOptions;
};

type GitHubAction =
  | CreateIssueAction
  | CreatePullRequestAction
  | SetTitleAction
  | SetBodyAction
  | AddLabelsAction
  | RemoveLabelsAction
  | ChangeStateAction
  | PostCommentAction
  | PostReviewAction
  | ReplyToDiffCommentAction
  | MergePullRequestAction;

type StoredActionRecord = {
  action: GitHubAction;
  state: StoredActionState;
  appliedAt?: number;
  rejectedAt?: number;
  revertInfo?: GitHubRevertInfo;
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ENTITY_CACHE_TTL_MS = 30 * 1000;
const LIST_CACHE_TTL_MS = 15 * 1000;
const VIEWER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCUSSION_SYNC_OVERLAP_MS = 5 * 1000;
const DISCUSSION_SYNC_BAIL_LIMIT = 500;
const MAX_REPLY_TARGET_HOPS = 50;

const GITHUB_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(GITHUB_LOGO_SVG)}`;

// `user:email` lets us read the account's primary verified email for sign-in (getAuthenticatedEmail).
const OAUTH_SCOPES = ["repo", "read:user", "user:email"];

// Minimal scopes for sign-in only (verify the user's email). Used when connecting in "auth" mode;
// the resulting grant is transient.
const AUTH_SCOPES = ["read:user", "user:email"];

const REPO_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo",
  title: "GitHub Repository",
  description: "Read and manage issues, pull requests, reviews, and discussions in a GitHub repository.",
};

const ISSUE_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo/issues/:number",
  title: "GitHub Issue",
  description: "Read and manage a specific GitHub issue.",
};

const PULL_REQUEST_RESOURCE: SupportedResource = {
  urlPattern: "https://github.com/:owner/:repo/pull/:number",
  title: "GitHub Pull Request",
  description: "Read and manage a specific GitHub pull request and its review threads.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [
  REPO_RESOURCE,
  ISSUE_RESOURCE,
  PULL_REQUEST_RESOURCE,
];

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authorization Link Expired</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Configuration Required</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">GitHub Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6; margin: 0;">Please configure a GitHub OAuth app client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/github");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function ensureConfigured(env: Env): void {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The GitHub gatekeeper is not configured.");
  }
}

function canonicalRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function issueUrl(owner: string, repo: string, id: string): string {
  return `${canonicalRepoUrl(owner, repo)}/issues/${id}`;
}

function pullUrl(owner: string, repo: string, id: string): string {
  return `${canonicalRepoUrl(owner, repo)}/pull/${id}`;
}

function repoRef(owner: string, repo: string): GitHubRepoRef {
  return {
    owner,
    name: repo,
    fullName: `${owner}/${repo}`,
    url: canonicalRepoUrl(owner, repo),
  };
}

function actorFromUser(user: { login: string; name?: string | null; html_url: string; avatar_url?: string } | null): GitHubActor | null {
  if (!user) return null;
  return {
    login: user.login,
    displayName: user.name ?? undefined,
    url: user.html_url,
    avatarUrl: user.avatar_url,
  };
}

function actorsFromUsers(
  users?: Array<{ login: string; name?: string | null; html_url: string; avatar_url?: string }> | null,
): GitHubActor[] {
  const result: GitHubActor[] = [];
  for (const user of users ?? []) {
    const actor = actorFromUser(user);
    if (actor) {
      result.push(actor);
    }
  }
  return result;
}

function actorFromLogin(login: string): GitHubActor {
  return {
    login,
    url: `https://github.com/${login}`,
  };
}

function labelFromResponse(label: GitHubLabelResponse): GitHubLabel {
  return {
    name: label.name,
    color: label.color,
    description: label.description ?? undefined,
  };
}

function dedupeLabels(labels: GitHubLabel[]): GitHubLabel[] {
  const seen = new Set<string>();
  const result: GitHubLabel[] = [];

  for (const label of labels) {
    const key = label.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(label);
    }
  }

  return result;
}

function textSnippet(markdown?: string, fallback = ""): string {
  const text = (markdown ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return fallback;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function parseDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

function normalizeStateReason(reason?: string | null): "completed" | "notPlanned" | undefined {
  switch (reason) {
    case "completed":
      return "completed";
    case "not_planned":
      return "notPlanned";
    default:
      return undefined;
  }
}

function denormalizeStateReason(reason?: "completed" | "notPlanned"): "completed" | "not_planned" | null {
  switch (reason) {
    case "completed":
      return "completed";
    case "notPlanned":
      return "not_planned";
    default:
      return null;
  }
}

function reviewDecisionFromState(state: string): GitHubReviewDecision {
  switch (state) {
    case "APPROVED":
      return "approve";
    case "CHANGES_REQUESTED":
      return "requestChanges";
    default:
      return "comment";
  }
}

function normalizeIssueSummary(owner: string, repo: string, response: GitHubIssueResponse): GitHubIssueSummary {
  return {
    repo: repoRef(owner, repo),
    id: String(response.number),
    url: issueUrl(owner, repo, String(response.number)),
    title: response.title,
    state: response.state,
    labels: response.labels.map(labelFromResponse),
    author: actorFromUser(response.user),
    assignees: actorsFromUsers(response.assignees),
    createdAt: new Date(response.created_at),
    updatedAt: new Date(response.updated_at),
    closedAt: parseDate(response.closed_at),
    commentCount: response.comments,
  };
}

function normalizeIssueDetails(owner: string, repo: string, response: GitHubIssueResponse): GitHubIssueDetails {
  return {
    ...normalizeIssueSummary(owner, repo, response),
    bodyMarkdown: response.body ?? "",
  };
}

function normalizePullBranchRef(
  fallbackOwner: string,
  fallbackRepo: string,
  response: GitHubPullRequestResponse["head"],
): GitHubPullRequestBranchRef {
  const branchRepo = response.repo;
  const owner = branchRepo?.owner.login ?? fallbackOwner;
  const repo = branchRepo?.name ?? fallbackRepo;
  return {
    ref: response.ref,
    sha: response.sha,
    repo: repoRef(owner, repo),
  };
}

function normalizePullSummary(
  owner: string,
  repo: string,
  response: GitHubPullRequestResponse,
): GitHubPullRequestSummary {
  return {
    ...normalizeIssueSummary(owner, repo, response),
    draft: response.draft,
    merged: !!response.merged_at,
    head: normalizePullBranchRef(owner, repo, response.head),
    base: normalizePullBranchRef(owner, repo, response.base),
  };
}

function normalizePullDetails(
  owner: string,
  repo: string,
  response: GitHubPullRequestResponse,
): GitHubPullRequestDetails {
  return {
    ...normalizeIssueDetails(owner, repo, response),
    ...normalizePullSummary(owner, repo, response),
    mergeable: response.mergeable ?? undefined,
    requestedReviewers: actorsFromUsers(response.requested_reviewers),
    commits: response.commits,
    additions: response.additions,
    deletions: response.deletions,
    changedFiles: response.changed_files,
  };
}

function summarizeIssueDetails(details: GitHubIssueDetails): GitHubIssueSummary {
  const { bodyMarkdown: _bodyMarkdown, ...summary } = details;
  return summary;
}

function summarizePullDetails(details: GitHubPullRequestDetails): GitHubPullRequestSummary {
  const {
    bodyMarkdown: _bodyMarkdown,
    mergeable: _mergeable,
    requestedReviewers: _requestedReviewers,
    commits: _commits,
    additions: _additions,
    deletions: _deletions,
    changedFiles: _changedFiles,
    ...summary
  } = details;
  return summary;
}

function stableKey(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

function matchesAllLabels(item: { labels: GitHubLabel[] }, labels?: string[]): boolean {
  if (!labels || labels.length === 0) return true;
  const available = new Set(item.labels.map(label => label.name.toLowerCase()));
  return labels.every(label => available.has(label.toLowerCase()));
}

function issueMatchesFilter(item: GitHubIssueSummary, filter?: GitHubIssueFilter): boolean {
  if (!filter) return true;
  if (filter.state && filter.state !== "all" && item.state !== filter.state) return false;
  if (!matchesAllLabels(item, filter.labels)) return false;
  if (filter.author && item.author?.login !== filter.author) return false;
  if (filter.assignee && !item.assignees.some(assignee => assignee.login === filter.assignee)) return false;
  return true;
}

function pullMatchesFilter(item: GitHubPullRequestSummary, filter?: GitHubPullRequestFilter): boolean {
  if (!filter) return true;
  if (filter.state && filter.state !== "all" && item.state !== filter.state) return false;
  if (filter.head) {
    const expected = filter.head.includes(":") ? filter.head : item.head.ref;
    if (item.head.ref !== filter.head && `${item.head.repo.owner}:${item.head.ref}` !== expected) {
      return false;
    }
  }
  if (filter.base && item.base.ref !== filter.base) return false;
  return true;
}

function issueMatchesSearch(item: GitHubIssueDetails, query: GitHubIssueSearch): boolean {
  if (!issueMatchesFilter(item, query)) return false;
  const haystack = `${item.title}\n${item.bodyMarkdown}`.toLowerCase();
  return haystack.includes(query.text.toLowerCase());
}

function pullMatchesSearch(item: GitHubPullRequestDetails, query: GitHubPullRequestSearch): boolean {
  const text = query.text.toLowerCase();
  const haystack = `${item.title}\n${item.bodyMarkdown}`.toLowerCase();
  if (!haystack.includes(text)) return false;
  if (query.state && query.state !== "all" && item.state !== query.state) return false;
  if (query.merged !== undefined && item.merged !== query.merged) return false;
  if (query.draft !== undefined && item.draft !== query.draft) return false;
  if (!matchesAllLabels(item, query.labels)) return false;
  if (query.author && item.author?.login !== query.author) return false;
  if (query.assignee && !item.assignees.some(assignee => assignee.login === query.assignee)) return false;
  return true;
}

function pullResponseMatchesSearch(
  owner: string,
  repo: string,
  response: GitHubPullRequestResponse,
  query: GitHubPullRequestSearch,
): boolean {
  const summary = normalizePullSummary(owner, repo, response);
  const text = query.text.toLowerCase();
  const haystack = `${summary.title}\n${response.body ?? ""}`.toLowerCase();
  if (!haystack.includes(text)) return false;
  if (query.state && query.state !== "all" && summary.state !== query.state) return false;
  if (query.merged !== undefined && summary.merged !== query.merged) return false;
  if (query.draft !== undefined && summary.draft !== query.draft) return false;
  if (!matchesAllLabels(summary, query.labels)) return false;
  if (query.author && summary.author?.login !== query.author) return false;
  if (query.assignee && !summary.assignees.some(assignee => assignee.login === query.assignee)) return false;
  return true;
}

function issueComparator(
  sort: "created" | "updated" | "comments" = "created",
  direction: "asc" | "desc" = "desc",
): (a: GitHubIssueSummary, b: GitHubIssueSummary) => number {
  const factor = direction === "asc" ? 1 : -1;
  return (a, b) => {
    let delta = 0;
    switch (sort) {
      case "comments":
        delta = a.commentCount - b.commentCount;
        break;
      case "updated":
        delta = a.updatedAt.getTime() - b.updatedAt.getTime();
        break;
      default:
        delta = a.createdAt.getTime() - b.createdAt.getTime();
        break;
    }
    if (delta === 0) {
      delta = a.id.localeCompare(b.id);
    }
    return delta * factor;
  };
}

function pullComparator(
  sort: "created" | "updated" | "popularity" | "long-running" = "created",
  direction: "asc" | "desc" = sort === "created" ? "desc" : "asc",
): (a: GitHubPullRequestSummary, b: GitHubPullRequestSummary) => number {
  const factor = direction === "asc" ? 1 : -1;
  return (a, b) => {
    let delta = 0;
    switch (sort) {
      case "popularity":
        delta = a.commentCount - b.commentCount;
        break;
      case "updated":
      case "long-running":
        delta = a.updatedAt.getTime() - b.updatedAt.getTime();
        break;
      default:
        delta = a.createdAt.getTime() - b.createdAt.getTime();
        break;
    }
    if (delta === 0) {
      delta = a.id.localeCompare(b.id);
    }
    return delta * factor;
  };
}

function parseDiffSide(side?: "LEFT" | "RIGHT" | null): "old" | "new" {
  return side === "LEFT" ? "old" : "new";
}

function diffCommentSignature(target: GitHubDiffCommentTarget, bodyMarkdown: string): string {
  return JSON.stringify({
    path: target.path,
    subjectType: target.subjectType,
    line: target.subjectType === "line" ? target.line : undefined,
    side: target.subjectType === "line" ? target.side : undefined,
    startLine: target.subjectType === "line" ? target.startLine : undefined,
    startSide: target.subjectType === "line" ? target.startSide : undefined,
    bodyMarkdown,
  });
}

function reviewCommentSignature(comment: GitHubPullRequestReviewCommentResponse): string {
  return diffCommentSignature(commentTargetFromResponse(comment), comment.body ?? "");
}

function commentTargetFromResponse(comment: GitHubPullRequestReviewCommentResponse): GitHubDiffCommentTarget {
  if (comment.subject_type === "file") {
    return {
      path: comment.path,
      subjectType: "file",
    };
  }

  return {
    path: comment.path,
    subjectType: "line",
    line: comment.line ?? comment.original_line ?? 1,
    side: parseDiffSide(comment.side),
    startLine: comment.start_line ?? comment.original_start_line ?? undefined,
    startSide: comment.start_side ? parseDiffSide(comment.start_side) : undefined,
  };
}

function discussionCommentFromResponse(comment: GitHubIssueCommentResponse): GitHubDiscussionCommentEntry {
  return {
    kind: "comment",
    id: String(comment.id),
    author: actorFromUser(comment.user),
    bodyMarkdown: comment.body ?? "",
    createdAt: new Date(comment.created_at),
    updatedAt: parseDate(comment.updated_at),
    url: comment.html_url,
  };
}

function parsePatch(patch: string): GitHubPullRequestDiffHunk[] {
  const lines = patch.split("\n");
  const hunks: GitHubPullRequestDiffHunk[] = [];
  let currentHunk: GitHubPullRequestDiffHunk | undefined;
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
      currentHunk.lines.push({
        kind: "added",
        text: line.slice(1),
        newLineNumber: newLine,
      });
      newLine += 1;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({
        kind: "removed",
        text: line.slice(1),
        oldLineNumber: oldLine,
      });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      currentHunk.lines.push({
        kind: "context",
        text: line,
      });
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

@validateRpc()
class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  #items: T[];
  #pageSize: number;
  #index = 0;

  constructor(items: T[], pageSize: number) {
    super();
    this.#items = items;
    this.#pageSize = pageSize;
  }

  async next(): Promise<T[] | null> {
    if (this.#index >= this.#items.length) {
      return null;
    }

    const next = this.#items.slice(this.#index, this.#index + this.#pageSize);
    this.#index += this.#pageSize;
    return next;
  }
}

/**
 * A cursor that lazily fetches pages from a remote API, applies an overlay and filter
 * to each item, and merges in pre-computed provisional items at their correct sort positions.
 *
 * This avoids the need to fetch ALL pages upfront before returning any results, which is
 * critical for repos with large issue/PR histories.
 */
@validateRpc()
class StreamingCursor<T> extends RpcTarget implements Cursor<T> {
  /** Fetches one page of already-normalized items from the remote API (or cache). */
  #fetchPage: (page: number, perPage: number) => Promise<T[]>;
  /** Applies simulation overlay to a single item. */
  #overlay: (item: T) => T;
  /** Returns false for items that should be excluded after overlay. */
  #filter: (item: T) => boolean;
  /**
   * Comparator consistent with the remote API's sort order.
   * Returns negative if a should come before b.
   */
  #comparator: (a: T, b: T) => number;
  /** Pre-computed injected items, already overlaid and filtered, sorted by #comparator. */
  #injectedItems: T[];
  #injectedIndex = 0;

  #buffer: T[] = [];
  #remotePage = 1;
  #remotePerPage: number;
  #remoteExhausted = false;
  #pageSize: number;

  constructor(options: {
    fetchPage: (page: number, perPage: number) => Promise<T[]>;
    overlay: (item: T) => T;
    filter: (item: T) => boolean;
    comparator: (a: T, b: T) => number;
    injectedItems: T[];
    pageSize: number;
    remotePageSize?: number;
  }) {
    super();
    this.#fetchPage = options.fetchPage;
    this.#overlay = options.overlay;
    this.#filter = options.filter;
    this.#comparator = options.comparator;
    this.#injectedItems = options.injectedItems;
    this.#pageSize = options.pageSize;
    this.#remotePerPage = options.remotePageSize ?? 100;
  }

  async next(): Promise<T[] | null> {
    // Fill the buffer until we have enough items for a full page, or all sources are exhausted.
    while (this.#buffer.length < this.#pageSize && !this.#fullyExhausted()) {
      await this.#loadMore();
    }

    if (this.#buffer.length === 0) return null;
    return this.#buffer.splice(0, this.#pageSize);
  }

  #fullyExhausted(): boolean {
    return this.#remoteExhausted && this.#injectedIndex >= this.#injectedItems.length;
  }

  async #loadMore(): Promise<void> {
    if (this.#remoteExhausted) {
      // Remote is done; flush remaining injected items into the buffer.
      while (this.#injectedIndex < this.#injectedItems.length) {
        this.#buffer.push(this.#injectedItems[this.#injectedIndex++]);
      }
      return;
    }

    const batch = await this.#fetchPage(this.#remotePage, this.#remotePerPage);
    this.#remotePage++;
    if (batch.length < this.#remotePerPage) {
      this.#remoteExhausted = true;
    }

    for (const raw of batch) {
      const overlaid = this.#overlay(raw);
      if (!this.#filter(overlaid)) continue;

      // Before appending this remote item, merge in any injected items that sort before it.
      while (this.#injectedIndex < this.#injectedItems.length &&
             this.#comparator(this.#injectedItems[this.#injectedIndex], overlaid) <= 0) {
        this.#buffer.push(this.#injectedItems[this.#injectedIndex++]);
      }
      this.#buffer.push(overlaid);
    }

    // If remote just became exhausted, flush remaining injected items.
    if (this.#remoteExhausted) {
      while (this.#injectedIndex < this.#injectedItems.length) {
        this.#buffer.push(this.#injectedItems[this.#injectedIndex++]);
      }
    }
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const redirectUrl = new URL("https://github.com/login/oauth/authorize");
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("scope", begun.scopes.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);

      return Response.redirect(redirectUrl.toString(), 302);
    }

    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("GitHub authorization failed. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return new Response("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub: DurableObjectStub<UserAccount> = ctx.exports.UserAccount.get(
        ctx.exports.UserAccount.idFromString(doId),
      );
      const accepted = await stub.acceptAuthCode(code, oauthNonce);
      if (!accepted) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(SELF_CLOSING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "GitHub",
      url: "https://github.com",
      logo: { url: GITHUB_LOGO_URL },
      color: "#f0f0f0",
      tagline: "Triage issues, review PRs, and manage repos",
      description:
          "Connect your GitHub account so Cloudflare OS can read and update issues, pull requests, " +
          "and reviews on the repositories you choose.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly ? AUTH_SCOPES : OAUTH_SCOPES;
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, scopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    requestedScopes?: string[], ephemeral?: boolean): Promise<void> {
    if (!this.ctx.storage.kv.get<string>("accessToken")) {
      await this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    }

    this.ctx.storage.kv.put("callback", callback);
    // Scopes to request in the authorize URL (auth-only for sign-in, or the full set).
    if (requestedScopes) this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    // Auth-only sign-in grants are transient: dropped shortly after the email is read.
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral ?? false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    const scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? OAUTH_SCOPES;
    return { oauthNonce, scopes };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    ensureConfigured(this.env);
    const clientId = this.env.CLIENT_ID;
    const clientSecret = this.env.CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("GitHub OAuth is not configured.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode(code, clientId, clientSecret, `${getBaseUrl(this.env)}/oauth`);

    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("scopes", grant.scopes);
    this.ctx.storage.kv.put("expiredNotified", false);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (error) {
        this.ctx.storage.kv.delete("accessToken");
        this.ctx.storage.kv.delete("scopes");
        throw error;
      }
      // Auth-only sign-in grants are transient: the caller read the email via complete(), so
      // schedule a prompt self-destruct. We do NOT call the provider revoke endpoint (it could
      // invalidate the user's other grants for this OAuth app); we just drop our local copy.
      if (this.ctx.storage.kv.get<boolean>("ephemeral")) {
        await this.ctx.storage.setAlarm(Date.now() + 2 * 60 * 1000);
        return true;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  getAccessToken(): string {
    const accessToken = this.ctx.storage.kv.get<string>("accessToken");
    if (!accessToken) {
      throw new Error("GitHub credentials have not been configured for this account.");
    }
    return accessToken;
  }

  getScopes(): string[] {
    return this.ctx.storage.kv.get<string[]>("scopes") ?? [];
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) {
      return;
    }

    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) {
      await callback.credentialsExpired();
    }
  }

  async alarm(): Promise<void> {
    // Drop the account if the flow never completed, or if this was a transient auth-only sign-in
    // grant (used once to read the email for login).
    if (!this.ctx.storage.kv.get<string>("accessToken") || this.ctx.storage.kv.get<boolean>("ephemeral")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const accessToken = this.ctx.storage.kv.get<string>("accessToken");
    if (accessToken && this.env.CLIENT_ID && this.env.CLIENT_SECRET) {
      try {
        await revokeOAuthGrant(accessToken, this.env.CLIENT_ID, this.env.CLIENT_SECRET);
      } catch (error) {
        logger.error("failed to revoke GitHub OAuth grant", {
          event: "oauth.grant.revoke.failed", error,
        });
      }
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps> implements GatekeeperUser {
  async #withApi<T>(fn: (api: GitHubApi, scopes: string[]) => Promise<T>): Promise<T> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const account = this.ctx.exports.UserAccount.get(id);
    const scopes = await account.getScopes();
    const api = new GitHubApi(async () => await account.getAccessToken());
    try {
      return await fn(api, scopes);
    } catch (error) {
      if (error instanceof GitHubApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("GitHub credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async (api, scopes) => {
      const viewer = await api.getViewer();
      return {
        displayName: viewer.user.name ?? viewer.user.login,
        uniqueName: viewer.user.login,
        avatar: { url: viewer.user.avatar_url },
      };
    });
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // GitHub's primary email is verified by GitHub, so it's safe as a sign-in identity.
    return await this.#withApi(api => api.getPrimaryVerifiedEmail());
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      throw new Error(`Unsupported GitHub URL: ${url}`);
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new Error(`Unsupported GitHub URL: ${url}`);
    }

    const [owner, repo, kind, number] = segments;
    const props: GitHubGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      owner,
      repo,
      resourceKind: "repo",
    };

    let resource = REPO_RESOURCE;
    if (kind === "issues" && number && /^\d+$/.test(number)) {
      props.resourceKind = "issue";
      props.issueNumber = Number(number);
      resource = ISSUE_RESOURCE;
    } else if (kind === "pull" && number && /^\d+$/.test(number)) {
      props.resourceKind = "pull";
      props.issueNumber = Number(number);
      resource = PULL_REQUEST_RESOURCE;
    }

    return {
      class: this.ctx.exports.GitHubGatekeeperImpl({ props }),
      resource,
    };
  }

  async startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    const getToken = async () => {
      const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
      const account = this.ctx.exports.UserAccount.get(id);
      return await account.getAccessToken();
    };

    if (resourceUrlPattern === REPO_RESOURCE.urlPattern) {
      return {
        iframeHtml: GITHUB_REPO_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitHubRepoConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === ISSUE_RESOURCE.urlPattern) {
      return {
        iframeHtml: GITHUB_ISSUE_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitHubIssueConfiguratorUI(getToken)),
      };
    }

    if (resourceUrlPattern === PULL_REQUEST_RESOURCE.urlPattern) {
      return {
        iframeHtml: GITHUB_PULL_REQUEST_CONFIGURATOR_HTML,
        ui: new RpcStub(new GitHubPullRequestConfiguratorUI(getToken)),
      };
    }

    throw new Error(`Unsupported GitHub resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(initiationNonce);
    return {
      url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}`,
    };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  /**
   * Mint a verifier representing this account, used by GitHubGatekeeperImpl.addObserver to confirm
   * a prospective observer is allowed to read a bound repository (see that method). The verifier
   * carries this user's own account id, so when the gatekeeper calls hasRepoAccess() the check runs
   * against the observer's *own* GitHub token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: GitHubVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.GitHubVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// GitHub uses the "ACL check (single unit)" observer strategy: a binding is a single repository (or
// a single issue/PR, which inherits the repo's ACL), so verifying an observer reduces to "can this
// user read the repo?".
//
// The verifier is minted by the *observer's* connected account (GatekeeperUserImpl.getVerifier) and
// carries that account's id, so `hasRepoAccess` queries GitHub with the observer's own token: if a
// plain `GET /repos/{owner}/{repo}` succeeds, the observer has at least read access; GitHub returns
// 404 (not 403) for repos a user can't see, so a 404 means "no access". The overseer only ever
// hands this verifier back to a GitHub gatekeeper, so that gatekeeper may trust the boolean result.

type GitHubVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard method the GitHub gatekeeper calls on its own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface GitHubVerifierApi extends GatekeeperUserVerifier {
  hasRepoAccess(owner: string, repo: string): Promise<boolean>;
}

@validateRpc()
export class GitHubVerifier extends WorkerEntrypoint<Env, GitHubVerifierProps>
    implements GitHubVerifierApi {
  async hasRepoAccess(owner: string, repo: string): Promise<boolean> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const account = this.ctx.exports.UserAccount.get(id);
    const api = new GitHubApi(async () => await account.getAccessToken());
    try {
      await api.getRepo(owner, repo);
      return true;
    } catch (error) {
      // GitHub returns 404 for private repos the token cannot see (to avoid leaking existence), and
      // 403 in some org-policy cases — either way the observer lacks read access.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403)) {
        return false;
      }
      throw error;
    }
  }
}

@validateRpc()
export class GitHubGatekeeperImpl extends DurableObject<Env, GitHubGatekeeperImplProps>
  implements Gatekeeper<GitHubRepoSession | GitHubIssue | GitHubPullRequest> {

  #pendingActionsCache?: GitHubAction[];

  #userAccount() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: GitHubApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const api = new GitHubApi(async () => await account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof GitHubApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error("GitHub credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  #counterKey(name: string): string {
    return `counter:${name}`;
  }

  #nextCounter(name: string): number {
    const key = this.#counterKey(name);
    const value = (this.ctx.storage.kv.get<number>(key) ?? 0) + 1;
    this.ctx.storage.kv.put(key, value);
    return value;
  }

  #nextActionId(): number {
    return this.#nextCounter("action");
  }

  #nextProvisionalResourceId(): string {
    return `~${this.#nextCounter("resource")}`;
  }

  #nextProvisionalCommentId(prefix: string): string {
    return `~${prefix}${this.#nextCounter(prefix)}`;
  }

  #cacheKey(kind: string, ...parts: string[]): string {
    return ["cache", kind, ...parts].join(":");
  }

  #cacheGeneration(): number {
    return this.ctx.storage.kv.get<number>("cacheGeneration") ?? 0;
  }

  #loadCached<T>(key: string, ttlMs: number): T | undefined {
    const cached = this.ctx.storage.kv.get<Cached<T>>(key);
    if (!cached) return undefined;
    if (cached.generation !== this.#cacheGeneration()) return undefined;
    if (Date.now() - cached.fetchedAt >= ttlMs) return undefined;
    return cached.value;
  }

  #getCachedRecord<T>(key: string): Cached<T> | undefined {
    const cached = this.ctx.storage.kv.get<Cached<T>>(key);
    if (!cached) return undefined;
    if (cached.generation !== this.#cacheGeneration()) return undefined;
    return cached;
  }

  #storeCached<T>(key: string, value: T, etag?: string): void {
    this.ctx.storage.kv.put<Cached<T>>(key, {
      fetchedAt: Date.now(),
      value,
      etag,
      generation: this.#cacheGeneration(),
    });
  }

  async #loadCachedWithEtag<T>(
    key: string,
    ttlMs: number,
    loader: (etag?: string) => Promise<ConditionalRequestResult<T>>,
  ): Promise<T> {
    const cached = this.#getCachedRecord<T>(key);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return cached.value;
    }

    const response = await loader(cached?.etag);
    if (response.status === 304) {
      if (!cached) {
        throw new Error(`GitHub returned 304 for uncached resource ${key}.`);
      }
      this.#storeCached(key, cached.value, response.headers.get("etag") ?? cached.etag);
      return cached.value;
    }

    const etag = response.headers.get("etag") ?? undefined;
    this.#storeCached(key, response.data, etag);
    return response.data;
  }

  #clearCaches(): void {
    this.ctx.storage.kv.put("cacheGeneration", this.#cacheGeneration() + 1);
  }

  #discussionCommentStateKey(realId: string): string {
    return `discussionComments:${realId}:state`;
  }

  #discussionCommentEntryPrefix(realId: string): string {
    return `discussionComments:${realId}:entry:`;
  }

  #discussionCommentEntryKey(realId: string, commentId: string): string {
    return `${this.#discussionCommentEntryPrefix(realId)}${commentId}`;
  }

  #getDiscussionCommentState(realId: string): StoredDiscussionCommentState | undefined {
    return this.ctx.storage.kv.get<StoredDiscussionCommentState>(this.#discussionCommentStateKey(realId));
  }

  #putDiscussionCommentState(realId: string, state: StoredDiscussionCommentState): void {
    this.ctx.storage.kv.put(this.#discussionCommentStateKey(realId), state);
  }

  #ensureDiscussionCommentState(realId: string, commentCount?: number): StoredDiscussionCommentState {
    const existing = this.#getDiscussionCommentState(realId);
    if (existing) {
      if (commentCount === 0 && existing.depth === 0 && !existing.exhausted) {
        existing.exhausted = true;
        this.#putDiscussionCommentState(realId, existing);
      }
      return existing;
    }

    const state: StoredDiscussionCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: commentCount === 0,
      ids: [],
    };
    this.#putDiscussionCommentState(realId, state);
    return state;
  }

  #resetDiscussionCommentState(realId: string, commentCount?: number): StoredDiscussionCommentState {
    const existing = this.#getDiscussionCommentState(realId);
    for (const commentId of existing?.ids ?? []) {
      this.ctx.storage.kv.delete(this.#discussionCommentEntryKey(realId, commentId));
    }

    const state: StoredDiscussionCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: commentCount === 0,
      ids: [],
    };
    this.#putDiscussionCommentState(realId, state);
    return state;
  }

  #readIndexedEntries<T>(ids: string[], prefix: string, label: string): T[] {
    const entries = new Map<string, T>();
    for (const [key, value] of this.ctx.storage.kv.list<T>({ prefix })) {
      entries.set(key.slice(prefix.length), value);
    }

    return ids.map(id => {
      const entry = entries.get(id);
      if (!entry) {
        throw new Error(`Cached GitHub ${label} ${id} is missing.`);
      }
      return entry;
    });
  }

  #readDiscussionCommentSlice(realId: string, offset: number, limit: number): GitHubDiscussionCommentEntry[] {
    const state = this.#getDiscussionCommentState(realId);
    if (!state) return [];

    return this.#readIndexedEntries<GitHubDiscussionCommentEntry>(
      state.ids.slice(offset, offset + limit),
      this.#discussionCommentEntryPrefix(realId),
      "discussion comment",
    );
  }

  async #syncDiscussionComments(realId: string, commentCount?: number): Promise<StoredDiscussionCommentState> {
    let state = this.#ensureDiscussionCommentState(realId, commentCount);
    if (commentCount !== undefined && state.depth > commentCount) {
      state = this.#resetDiscussionCommentState(realId, commentCount);
    }
    if (Date.now() - state.freshness < ENTITY_CACHE_TTL_MS) {
      return state;
    }

    const since = new Date(Math.max(0, state.freshness - DISCUSSION_SYNC_OVERLAP_MS)).toISOString();
    const knownIds = new Set(state.ids);
    const updates = new Map<string, GitHubDiscussionCommentEntry>();
    const appended: GitHubDiscussionCommentEntry[] = [];
    let changedCount = 0;

    for (let page = 1; ; page += 1) {
      const batch = await this.#withApi(api =>
        api.listIssueComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          100,
          since,
        ));
      changedCount += batch.length;
      if (changedCount > DISCUSSION_SYNC_BAIL_LIMIT) {
        return this.#resetDiscussionCommentState(realId, commentCount);
      }

      for (const comment of batch) {
        const normalized = discussionCommentFromResponse(comment);
        if (knownIds.has(normalized.id)) {
          updates.set(normalized.id, normalized);
        } else if (state.exhausted) {
          appended.push(normalized);
          knownIds.add(normalized.id);
        }
      }

      if (batch.length < 100) {
        break;
      }
    }

    for (const [commentId, comment] of updates) {
      this.ctx.storage.kv.put(this.#discussionCommentEntryKey(realId, commentId), comment);
    }

    if (appended.length > 0) {
      appended.sort((a, b) => {
        const delta = a.createdAt.getTime() - b.createdAt.getTime();
        return delta === 0 ? a.id.localeCompare(b.id) : delta;
      });
      for (const comment of appended) {
        this.ctx.storage.kv.put(this.#discussionCommentEntryKey(realId, comment.id), comment);
        state.ids.push(comment.id);
      }
      state.depth = state.ids.length;
    }

    state.freshness = Date.now();
    this.#putDiscussionCommentState(realId, state);
    return state;
  }

  async #materializeDiscussionCommentDepth(
    realId: string,
    targetDepth: number,
    chunkHint: number,
  ): Promise<StoredDiscussionCommentState> {
    let state = this.#ensureDiscussionCommentState(realId);
    if (targetDepth <= state.depth || state.exhausted) {
      return state;
    }

    const chunkSize = Math.max(1, Math.min(100, state.chunkSize ?? chunkHint));
    state.chunkSize = chunkSize;
    let restarted = false;

    while (state.depth < targetDepth && !state.exhausted) {
      const knownIds = new Set(state.ids);
      const page = Math.floor(state.depth / chunkSize) + 1;
      const batch = await this.#withApi(api =>
        api.listIssueComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          chunkSize,
        ));
      const normalized = batch.map(discussionCommentFromResponse);

      if (state.depth > 0 && normalized.some(comment => knownIds.has(comment.id))) {
        if (restarted) {
          throw new Error(`GitHub discussion pagination shifted while loading #${realId}. Retry the request.`);
        }
        state = this.#resetDiscussionCommentState(realId);
        state.chunkSize = chunkSize;
        restarted = true;
        continue;
      }

      restarted = false;
      for (const comment of normalized) {
        if (knownIds.has(comment.id)) continue;
        this.ctx.storage.kv.put(this.#discussionCommentEntryKey(realId, comment.id), comment);
        state.ids.push(comment.id);
        knownIds.add(comment.id);
      }

      state.depth = state.ids.length;
      if (batch.length < chunkSize) {
        state.exhausted = true;
        state.freshness = Date.now();
      }
      this.#putDiscussionCommentState(realId, state);
    }

    return state;
  }

  #pullReviewCommentStateKey(realId: string): string {
    return `pullReviewComments:${realId}:state`;
  }

  #pullReviewCommentEntryPrefix(realId: string): string {
    return `pullReviewComments:${realId}:entry:`;
  }

  #pullReviewCommentEntryKey(realId: string, commentId: string): string {
    return `${this.#pullReviewCommentEntryPrefix(realId)}${commentId}`;
  }

  #getPullReviewCommentState(realId: string): StoredPullReviewCommentState | undefined {
    return this.ctx.storage.kv.get<StoredPullReviewCommentState>(this.#pullReviewCommentStateKey(realId));
  }

  #putPullReviewCommentState(realId: string, state: StoredPullReviewCommentState): void {
    this.ctx.storage.kv.put(this.#pullReviewCommentStateKey(realId), state);
  }

  #ensurePullReviewCommentState(realId: string): StoredPullReviewCommentState {
    const existing = this.#getPullReviewCommentState(realId);
    if (existing) {
      return existing;
    }

    const state: StoredPullReviewCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: false,
      ids: [],
    };
    this.#putPullReviewCommentState(realId, state);
    return state;
  }

  #resetPullReviewCommentState(realId: string): StoredPullReviewCommentState {
    const existing = this.#getPullReviewCommentState(realId);
    for (const commentId of existing?.ids ?? []) {
      this.ctx.storage.kv.delete(this.#pullReviewCommentEntryKey(realId, commentId));
    }

    const state: StoredPullReviewCommentState = {
      depth: 0,
      freshness: Date.now(),
      exhausted: false,
      ids: [],
    };
    this.#putPullReviewCommentState(realId, state);
    return state;
  }

  #readAllPullReviewComments(realId: string): GitHubPullRequestReviewCommentResponse[] {
    const state = this.#getPullReviewCommentState(realId);
    if (!state) return [];

    return this.#readIndexedEntries<GitHubPullRequestReviewCommentResponse>(
      state.ids,
      this.#pullReviewCommentEntryPrefix(realId),
      "pull review comment",
    );
  }

  async #syncPullReviewComments(realId: string): Promise<StoredPullReviewCommentState> {
    const state = this.#ensurePullReviewCommentState(realId);
    if (Date.now() - state.freshness < ENTITY_CACHE_TTL_MS) {
      return state;
    }

    const since = new Date(Math.max(0, state.freshness - DISCUSSION_SYNC_OVERLAP_MS)).toISOString();
    const knownIds = new Set(state.ids);
    const updates = new Map<string, GitHubPullRequestReviewCommentResponse>();
    const appended: GitHubPullRequestReviewCommentResponse[] = [];
    let changedCount = 0;

    for (let page = 1; ; page += 1) {
      const batch = await this.#withApi(api =>
        api.listPullRequestReviewComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          100,
          since,
        ));
      changedCount += batch.length;
      if (changedCount > DISCUSSION_SYNC_BAIL_LIMIT) {
        return this.#resetPullReviewCommentState(realId);
      }

      for (const comment of batch) {
        const commentId = String(comment.id);
        if (knownIds.has(commentId)) {
          updates.set(commentId, comment);
        } else if (state.exhausted) {
          appended.push(comment);
          knownIds.add(commentId);
        }
      }

      if (batch.length < 100) {
        break;
      }
    }

    for (const [commentId, comment] of updates) {
      this.ctx.storage.kv.put(this.#pullReviewCommentEntryKey(realId, commentId), comment);
    }

    if (appended.length > 0) {
      appended.sort((a, b) => {
        const delta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return delta === 0 ? a.id - b.id : delta;
      });
      for (const comment of appended) {
        const commentId = String(comment.id);
        this.ctx.storage.kv.put(this.#pullReviewCommentEntryKey(realId, commentId), comment);
        state.ids.push(commentId);
      }
      state.depth = state.ids.length;
    }

    state.freshness = Date.now();
    this.#putPullReviewCommentState(realId, state);
    return state;
  }

  async #materializeAllPullReviewComments(realId: string): Promise<GitHubPullRequestReviewCommentResponse[]> {
    let state = this.#ensurePullReviewCommentState(realId);
    const chunkSize = Math.max(1, Math.min(100, state.chunkSize ?? 100));
    state.chunkSize = chunkSize;
    let restarted = false;

    while (!state.exhausted) {
      const knownIds = new Set(state.ids);
      const page = Math.floor(state.depth / chunkSize) + 1;
      const batch = await this.#withApi(api =>
        api.listPullRequestReviewComments(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          chunkSize,
        ));

      if (state.depth > 0 && batch.some(comment => knownIds.has(String(comment.id)))) {
        if (restarted) {
          throw new Error(`GitHub pull review comment pagination shifted while loading #${realId}. Retry the request.`);
        }
        state = this.#resetPullReviewCommentState(realId);
        state.chunkSize = chunkSize;
        restarted = true;
        continue;
      }

      restarted = false;
      for (const comment of batch) {
        const commentId = String(comment.id);
        if (knownIds.has(commentId)) continue;
        this.ctx.storage.kv.put(this.#pullReviewCommentEntryKey(realId, commentId), comment);
        state.ids.push(commentId);
        knownIds.add(commentId);
      }

      state.depth = state.ids.length;
      if (batch.length < chunkSize) {
        state.exhausted = true;
        state.freshness = Date.now();
      }
      this.#putPullReviewCommentState(realId, state);
    }

    return this.#readAllPullReviewComments(realId);
  }

  #actionRecordKey(approvalId: number): string {
    return `action:${approvalId}`;
  }

  #retiredActionRecordKey(approvalId: number): string {
    return `retiredAction:${approvalId}`;
  }

  #getLiveActionRecord(approvalId: number): StoredActionRecord | undefined {
    return this.ctx.storage.kv.get<StoredActionRecord>(this.#actionRecordKey(approvalId));
  }

  #getActionRecord(approvalId: number): StoredActionRecord | undefined {
    return this.#getLiveActionRecord(approvalId)
      ?? this.ctx.storage.kv.get<StoredActionRecord>(this.#retiredActionRecordKey(approvalId));
  }

  #requireActionRecord(approvalId: number): StoredActionRecord {
    const record = this.#getActionRecord(approvalId);
    if (!record) {
      throw new Error(`No queued GitHub action exists with id ${approvalId}.`);
    }
    return record;
  }

  #putActionRecord(approvalId: number, record: StoredActionRecord): void {
    this.ctx.storage.kv.put(this.#actionRecordKey(approvalId), record);
  }

  #putRetiredActionRecord(approvalId: number, record: StoredActionRecord): void {
    this.ctx.storage.kv.put(this.#retiredActionRecordKey(approvalId), record);
  }

  #retireActionRecord(approvalId: number, record: StoredActionRecord): void {
    this.ctx.storage.kv.delete(this.#actionRecordKey(approvalId));
    this.#putRetiredActionRecord(approvalId, record);
  }

  #stageAction(action: GitHubAction): void {
    this.#putActionRecord(action.approvalId, {
      action,
      state: "staged",
    });
    this.#pendingActionsCache = undefined;
  }

  #listPendingActions(): GitHubAction[] {
    if (!this.#pendingActionsCache) {
      this.#pendingActionsCache = [...this.ctx.storage.kv.list<StoredActionRecord>({ prefix: "action:" })]
        .map(([, value]) => value)
        .filter(record => record.state === "pending")
        .map(record => record.action)
        .toSorted((a, b) => a.submittedAt - b.submittedAt);
    }

    return this.#pendingActionsCache;
  }

  #markActionPending(action: GitHubAction): void {
    const record = this.#requireActionRecord(action.approvalId);
    record.state = "pending";
    this.#putActionRecord(action.approvalId, record);
    this.#pendingActionsCache = undefined;
    if (action.type === "createIssue" || action.type === "createPullRequest") {
      this.ctx.storage.kv.put<StoredProvisionalResource>(`provisional:${action.provisionalId}`, {
        kind: action.type === "createIssue" ? "issue" : "pull",
      });
    }
  }

  #markActionApproved(action: GitHubAction, revertInfo?: GitHubRevertInfo): void {
    const record = this.#requireActionRecord(action.approvalId);
    record.state = "approved";
    record.appliedAt = Date.now();
    if (revertInfo) {
      record.revertInfo = revertInfo;
    }
    this.#retireActionRecord(action.approvalId, record);
    this.#pendingActionsCache = undefined;
  }

  #markActionRejected(action: GitHubAction): void {
    const record = this.#requireActionRecord(action.approvalId);
    record.state = "rejected";
    record.rejectedAt = Date.now();
    this.#retireActionRecord(action.approvalId, record);
    this.#pendingActionsCache = undefined;
  }

  #actionDependsOnResource(action: GitHubAction, kind: EntityKind, provisionalId: string): boolean {
    switch (action.type) {
      case "createIssue":
      case "createPullRequest":
        return action.provisionalId === provisionalId;
      case "setTitle":
      case "setBody":
      case "addLabels":
      case "removeLabels":
      case "changeState":
      case "postComment":
        return action.targetKind === kind && action.targetId === provisionalId;
      case "postReview":
      case "replyToDiffComment":
      case "mergePullRequest":
        return kind === "pull" && action.pullId === provisionalId;
    }
  }

  #rejectActionsForResource(kind: EntityKind, provisionalId: string): void {
    for (const pending of this.#listPendingActions()) {
      if (this.#actionDependsOnResource(pending, kind, provisionalId)) {
        this.#markActionRejected(pending);
      }
    }
  }

  #rejectReplyDependencyChain(rootCommentIds: string[]): void {
    const pendingActions = this.#listPendingActions();
    const pendingReplies = pendingActions.filter(
      (action): action is ReplyToDiffCommentAction => action.type === "replyToDiffComment",
    );
    const queue = [...rootCommentIds];
    const seen = new Set<string>(rootCommentIds);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        break;
      }
      for (const reply of pendingReplies) {
        if (reply.commentId === current) {
          this.#markActionRejected(reply);
          if (!seen.has(reply.provisionalCommentId)) {
            seen.add(reply.provisionalCommentId);
            queue.push(reply.provisionalCommentId);
          }
        }
      }
    }
  }

  #getProvisionalResource(id: string): StoredProvisionalResource | undefined {
    return this.ctx.storage.kv.get<StoredProvisionalResource>(`provisional:${id}`);
  }

  #setProvisionalResource(id: string, record: StoredProvisionalResource): void {
    this.ctx.storage.kv.put(`provisional:${id}`, record);
  }

  #resolveProvisionalId(id: string): string | undefined {
    const provisional = this.#getProvisionalResource(id);
    return provisional?.realId;
  }

  #entityIdMatches(targetId: string, logicalId: string): boolean {
    if (targetId === logicalId) return true;
    const targetResolved = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
    const logicalResolved = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    return !!targetResolved && !!logicalResolved && targetResolved === logicalResolved;
  }

  #pendingActionsForEntity(kind: EntityKind, logicalId: string): GitHubAction[] {
    return this.#listPendingActions().filter(action => {
      if (action.type === "createIssue" || action.type === "createPullRequest") {
        return false;
      }

      if (action.type === "postReview" || action.type === "replyToDiffComment" || action.type === "mergePullRequest") {
        if (kind !== "pull") return false;
        return this.#entityIdMatches(action.pullId, logicalId);
      }

      return action.targetKind === kind && this.#entityIdMatches(action.targetId, logicalId);
    });
  }

  #findCreateAction(id: string, kind: EntityKind): CreateIssueAction | CreatePullRequestAction | undefined {
    return this.#listPendingActions().find(action => {
      if (kind === "issue" && action.type === "createIssue") {
        return action.provisionalId === id;
      }
      if (kind === "pull" && action.type === "createPullRequest") {
        return action.provisionalId === id;
      }
      return false;
    }) as CreateIssueAction | CreatePullRequestAction | undefined;
  }

  #rewriteKnownReferences(text: string, requireAll: boolean): string {
    return text.replace(/#(~\d+)/g, (_, provisionalId: string) => {
      const realId = this.#resolveProvisionalId(provisionalId);
      if (!realId && requireAll) {
        throw new Error(
          `Reference ${provisionalId} points to a provisional issue or pull request that has not been created on GitHub yet. Retry after its create action is approved.`,
        );
      }

      return realId ? `#${realId}` : `#${provisionalId}`;
    });
  }

  async #getViewerActor(): Promise<GitHubActor> {
    const viewer = await this.#loadCachedWithEtag<StoredViewer>(
      this.#cacheKey("viewer"),
      VIEWER_CACHE_TTL_MS,
      async etag => {
        const result = await this.#withApi(api => api.getViewerConditional({ ifNoneMatch: etag }));
        if (result.status === 304) {
          return result;
        }

        const actor = actorFromUser(result.data);
        if (!actor) {
          throw new Error("Failed to identify the connected GitHub account.");
        }

        return {
          status: 200,
          headers: result.headers,
          data: {
            actor,
            fetchedAt: Date.now(),
          },
        };
      },
    );
    return viewer.actor;
  }

  async #fetchAllPages<T>(loader: (page: number, perPage: number) => Promise<T[]>): Promise<T[]> {
    const results: T[] = [];
    const perPage = 100;
    for (let page = 1; ; page += 1) {
      const batch = await loader(page, perPage);
      results.push(...batch);
      if (batch.length < perPage) {
        break;
      }
    }
    return results;
  }

  #pendingExistingEntityIds(kind: EntityKind): Set<string> {
    const ids = new Set<string>();
    for (const action of this.#listPendingActions()) {
      let targetId: string | undefined;
      switch (action.type) {
        case "setTitle":
        case "setBody":
        case "addLabels":
        case "removeLabels":
        case "changeState":
        case "postComment":
          if (action.targetKind === kind) {
            targetId = action.targetId;
          }
          break;
        case "postReview":
        case "replyToDiffComment":
        case "mergePullRequest":
          if (kind === "pull") {
            targetId = action.pullId;
          }
          break;
        default:
          break;
      }

      if (!targetId) continue;
      const realId = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
      if (realId) {
        ids.add(realId);
      }
    }
    return ids;
  }



  async #getRepoMetadata(): Promise<GitHubRepoMetadata> {
    const key = this.#cacheKey("repo", this.ctx.props.owner, this.ctx.props.repo);
    return await this.#loadCachedWithEtag<GitHubRepoMetadata>(key, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getRepoConditional(this.ctx.props.owner, this.ctx.props.repo, { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }

      return {
        status: 200,
        headers: result.headers,
        data: {
          ...repoRef(this.ctx.props.owner, this.ctx.props.repo),
          description: result.data.description ?? undefined,
          visibility: result.data.visibility ?? (result.data.private ? "private" : "public"),
        },
      };
    });
  }

  #getPendingStateInfo(
    targetKind: EntityKind,
    targetId: string,
  ): { state: GitHubIssueState; reason?: "completed" | "notPlanned" } | undefined {
    const latestStateAction = [...this.#pendingActionsForEntity(targetKind, targetId)]
      .toReversed()
      .find((action): action is ChangeStateAction | MergePullRequestAction =>
        action.type === "changeState" || action.type === "mergePullRequest",
      );

    if (!latestStateAction) {
      return undefined;
    }

    if (latestStateAction.type === "mergePullRequest") {
      return { state: "closed" };
    }

    return {
      state: latestStateAction.state,
      reason: latestStateAction.reason,
    };
  }

  async #getCurrentStateInfo(
    targetKind: EntityKind,
    targetId: string,
  ): Promise<{ state: GitHubIssueState; reason?: "completed" | "notPlanned" }> {
    const pending = this.#getPendingStateInfo(targetKind, targetId);
    if (pending) {
      return {
        state: pending.state,
        reason: pending.reason,
      };
    }

    const realId = targetId.startsWith("~") ? this.#resolveProvisionalId(targetId) : targetId;
    if (!realId) {
      const details = targetKind === "issue"
        ? await this.#getIssueDetails(targetId)
        : await this.#getPullRequestDetails(targetId);
      return {
        state: details.state,
        reason: undefined,
      };
    }

    const current = await this.#withApi(api => api.getIssue(this.ctx.props.owner, this.ctx.props.repo, Number(realId)));
    return {
      state: current.state,
      reason: normalizeStateReason(current.state_reason),
    };
  }

  async #getIssueDetails(logicalId: string): Promise<GitHubIssueDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "issue") {
        throw new Error(`No provisional issue exists with id ${logicalId}`);
      }

      if (provisional.realId) {
        const remote = await this.#getRemoteIssueDetails(provisional.realId);
        return this.#overlayIssueLike(remote, "issue", logicalId);
      }

      const createAction = this.#findCreateAction(logicalId, "issue") as CreateIssueAction | undefined;
      if (!createAction) {
        throw new Error(`Provisional issue ${logicalId} is no longer available.`);
      }

      const provisionalIssue = await this.#buildProvisionalIssueDetails(createAction);
      return this.#overlayIssueLike(provisionalIssue, "issue", logicalId, true);
    }

    return this.#overlayIssueLike(await this.#getRemoteIssueDetails(logicalId), "issue", logicalId);
  }

  async #getPullRequestDetails(logicalId: string): Promise<GitHubPullRequestDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "pull") {
        throw new Error(`No provisional pull request exists with id ${logicalId}`);
      }

      if (provisional.realId) {
        const remote = await this.#getRemotePullRequestDetails(provisional.realId);
        return this.#overlayIssueLike(remote, "pull", logicalId);
      }

      const createAction = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!createAction) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      const provisionalPull = await this.#buildProvisionalPullRequestDetails(createAction);
      return this.#overlayIssueLike(provisionalPull, "pull", logicalId, true);
    }

    return this.#overlayIssueLike(await this.#getRemotePullRequestDetails(logicalId), "pull", logicalId);
  }

  async #getRemoteIssueDetails(realId: string): Promise<GitHubIssueDetails> {
    const key = this.#cacheKey("issue", realId);
    const details = await this.#loadCachedWithEtag<GitHubIssueDetails>(key, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getIssueConditional(this.ctx.props.owner, this.ctx.props.repo, Number(realId), { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }
      if (result.data.pull_request) {
        throw new Error(`#${realId} is a pull request, not an issue.`);
      }

      return {
        status: 200,
        headers: result.headers,
        data: normalizeIssueDetails(this.ctx.props.owner, this.ctx.props.repo, result.data),
      };
    });
    this.#ensureDiscussionCommentState(realId, details.commentCount);
    return details;
  }

  async #getRemotePullRequestDetails(realId: string): Promise<GitHubPullRequestDetails> {
    const key = this.#cacheKey("pull", realId);
    const details = await this.#loadCachedWithEtag<GitHubPullRequestDetails>(
      key,
      ENTITY_CACHE_TTL_MS,
      async etag => {
        const result = await this.#withApi(api =>
          api.getPullRequestConditional(this.ctx.props.owner, this.ctx.props.repo, Number(realId), { ifNoneMatch: etag })
        );
        if (result.status === 304) {
          return result;
        }

        return {
          status: 200,
          headers: result.headers,
          data: normalizePullDetails(this.ctx.props.owner, this.ctx.props.repo, result.data),
        };
      },
    );
    this.#ensureDiscussionCommentState(realId, details.commentCount);
    this.#ensurePullReviewCommentState(realId);
    return details;
  }

  async #getLiveTopLevelCommentCount(kind: EntityKind, realId: string): Promise<number> {
    if (kind === "issue") {
      const issue = await this.#withApi(api => api.getIssue(this.ctx.props.owner, this.ctx.props.repo, Number(realId)));
      if (issue.pull_request) {
        throw new Error(`#${realId} is a pull request, not an issue.`);
      }
      return issue.comments;
    }

    const pull = await this.#withApi(api => api.getPullRequest(this.ctx.props.owner, this.ctx.props.repo, Number(realId)));
    return pull.comments;
  }

  async #buildProvisionalIssueDetails(action: CreateIssueAction): Promise<GitHubIssueDetails> {
    const viewer = await this.#getViewerActor();
    return {
      repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      id: action.provisionalId,
      url: issueUrl(this.ctx.props.owner, this.ctx.props.repo, action.provisionalId),
      title: action.options.title,
      state: "open",
      labels: (action.options.labels ?? []).map(name => ({ name })),
      author: viewer,
      assignees: (action.options.assignees ?? []).map(actorFromLogin),
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
    };
  }

  async #buildProvisionalPullRequestDetails(action: CreatePullRequestAction): Promise<GitHubPullRequestDetails> {
    const viewer = await this.#getViewerActor();
    let baseSha = "";
    let headSha = "";
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    let changedFiles = 0;

    try {
      const comparison = await this.#withApi(api => api.compareBranches(
        this.ctx.props.owner,
        this.ctx.props.repo,
        action.options.base,
        action.options.head,
      ));
      baseSha = comparison.base_commit.sha;
      headSha = comparison.commits?.at(-1)?.sha ?? comparison.base_commit.sha;
      commits = comparison.total_commits;
      additions = (comparison.files ?? []).reduce((sum, file) => sum + file.additions, 0);
      deletions = (comparison.files ?? []).reduce((sum, file) => sum + file.deletions, 0);
      changedFiles = comparison.files?.length ?? 0;
    } catch (error) {
      logger.warn("failed to compute provisional pull request comparison", {
        event: "pull.request.provisional.comparison.compute.failed", error,
      });
    }

    return {
      repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      id: action.provisionalId,
      url: pullUrl(this.ctx.props.owner, this.ctx.props.repo, action.provisionalId),
      title: action.options.title,
      state: "open",
      labels: [],
      author: viewer,
      assignees: [],
      createdAt: new Date(action.submittedAt),
      updatedAt: new Date(action.submittedAt),
      commentCount: 0,
      bodyMarkdown: action.options.bodyMarkdown ?? "",
      draft: action.options.draft ?? false,
      merged: false,
      head: {
        ref: action.options.head,
        sha: headSha,
        repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      },
      base: {
        ref: action.options.base,
        sha: baseSha,
        repo: repoRef(this.ctx.props.owner, this.ctx.props.repo),
      },
      mergeable: undefined,
      requestedReviewers: [],
      commits,
      additions,
      deletions,
      changedFiles,
    };
  }

  #overlayIssueLike<T extends GitHubIssueSummary | GitHubIssueDetails | GitHubPullRequestSummary | GitHubPullRequestDetails>(
    base: T,
    kind: EntityKind,
    logicalId: string,
    includeCreate = false,
  ): T {
    const result = structuredClone(base);
    const actions = this.#pendingActionsForEntity(kind, logicalId);
    for (const action of actions) {
      switch (action.type) {
        case "setTitle":
          result.title = action.title;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "setBody":
          if ("bodyMarkdown" in result) {
            result.bodyMarkdown = this.#rewriteKnownReferences(action.bodyMarkdown, false);
            result.updatedAt = new Date(action.submittedAt);
          }
          break;
        case "addLabels": {
          const existing = new Set(result.labels.map(label => label.name.toLowerCase()));
          for (const label of action.labels) {
            if (!existing.has(label.toLowerCase())) {
              result.labels.push({ name: label });
            }
          }
          result.labels = dedupeLabels(result.labels);
          result.updatedAt = new Date(action.submittedAt);
          break;
        }
        case "removeLabels":
          result.labels = result.labels.filter(label => !action.labels.some(name => name.toLowerCase() === label.name.toLowerCase()));
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "changeState":
          result.state = action.state;
          result.closedAt = action.state === "closed" ? new Date(action.submittedAt) : undefined;
          result.updatedAt = new Date(action.submittedAt);
          if ("merged" in result && action.state === "open") {
            result.merged = false;
          }
          break;
        case "postComment":
          result.commentCount += 1;
          result.updatedAt = new Date(action.submittedAt);
          break;
        case "mergePullRequest":
          if ("merged" in result) {
            result.state = "closed";
            result.merged = true;
            result.closedAt = new Date(action.submittedAt);
            result.updatedAt = new Date(action.submittedAt);
          }
          break;
        default:
          break;
      }
    }

    if (includeCreate) {
      const lastAction = actions.at(-1);
      result.updatedAt = lastAction ? new Date(lastAction.submittedAt) : result.updatedAt;
    }

    return result;
  }

  async #buildTouchedIssueSummaries(
    predicate: (item: GitHubIssueDetails) => boolean,
    compare: (a: GitHubIssueSummary, b: GitHubIssueSummary) => number,
  ): Promise<{ ids: Set<string>; items: GitHubIssueSummary[] }> {
    const ids = this.#pendingExistingEntityIds("issue");
    const items = (await Promise.all([...ids].map(async id => this.#getIssueDetails(id))))
      .filter(predicate)
      .map(details => summarizeIssueDetails(details))
      .toSorted(compare);
    return { ids, items };
  }

  async #buildTouchedPullSummaries(
    predicate: (item: GitHubPullRequestDetails) => boolean,
    compare: (a: GitHubPullRequestSummary, b: GitHubPullRequestSummary) => number,
  ): Promise<{ ids: Set<string>; items: GitHubPullRequestSummary[] }> {
    const ids = this.#pendingExistingEntityIds("pull");
    const items = (await Promise.all([...ids].map(async id => this.#getPullRequestDetails(id))))
      .filter(predicate)
      .map(details => summarizePullDetails(details))
      .toSorted(compare);
    return { ids, items };
  }

  async #listIssueSummaries(filter: GitHubIssueFilter | undefined, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    const compare = issueComparator(filter?.sort, filter?.direction);
    const touched = await this.#buildTouchedIssueSummaries(item => issueMatchesFilter(item, filter), compare);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreateIssueAction => action.type === "createIssue")
      .map(action => this.#buildProvisionalIssueDetails(action).then(issue => this.#overlayIssueLike(issue, "issue", action.provisionalId, true)))))
      .filter(item => issueMatchesFilter(item, filter))
      .toSorted(compare);
    const injectedItems = [...touched.items, ...provisionals].toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    return new StreamingCursor<GitHubIssueSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-issues", stableKey(filter ?? {}), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubIssueSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listIssuesConditional(owner, repo, {
            state: filter?.state,
            labels: filter?.labels?.join(","),
            creator: filter?.author,
            assignee: filter?.assignee,
            sort: filter?.sort,
            direction: filter?.direction,
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data
              .filter(item => !item.pull_request && !touched.ids.has(String(item.number)))
              .map(item => normalizeIssueSummary(owner, repo, item)),
          };
        });
      },
      overlay: item => this.#overlayIssueLike(item, "issue", item.id),
      filter: item => issueMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  async #searchIssueSummaries(query: GitHubIssueSearch, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    const remoteSort = query.sort ?? "created";
    const remoteDirection = query.direction ?? "desc";
    const compare = issueComparator(remoteSort, remoteDirection);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreateIssueAction => action.type === "createIssue")
      .map(action => this.#buildProvisionalIssueDetails(action).then(issue => this.#overlayIssueLike(issue, "issue", action.provisionalId, true)))))
      .filter(item => issueMatchesSearch(item, query))
      .toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    const searchQuery = buildIssueSearchQuery(owner, repo, query);
    const assertSearchScope = (results: readonly Pick<GitHubIssueResponse, "html_url">[]) => {
      try {
        assertIssueSearchResultsInRepo(owner, repo, results);
      } catch (error) {
        logger.warn("GitHub issue search scope validation failed", {
          event: "issue.search.scope.validation.failed", error,
        });
        throw error;
      }
    };
    return new StreamingCursor<GitHubIssueSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("search-issues-scoped-v1", stableKey(query), `p${page}`);
        const results = await this.#loadCachedWithEtag<CachedIssueSearchResult[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api =>
            api.searchIssuesConditional(searchQuery, page, perPage, remoteSort, remoteDirection, { ifNoneMatch: etag })
          );
          if (raw.status === 304) {
            return raw;
          }

          assertSearchScope(raw.data.items);
          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.items.map(item => ({
              html_url: item.html_url,
              summary: normalizeIssueSummary(owner, repo, item),
            })),
          };
        });
        assertSearchScope(results);
        return results.map(item => item.summary);
      },
      overlay: item => this.#overlayIssueLike(item, "issue", item.id),
      filter: () => true,  // Search scope was validated before results entered the cursor.
      comparator: compare,
      injectedItems: provisionals,
      pageSize,
    });
  }

  async #listPullSummaries(filter: GitHubPullRequestFilter | undefined, pageSize: number): Promise<Cursor<GitHubPullRequestSummary>> {
    const compare = pullComparator(filter?.sort, filter?.direction);
    const touched = await this.#buildTouchedPullSummaries(item => pullMatchesFilter(item, filter), compare);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreatePullRequestAction => action.type === "createPullRequest")
      .map(action => this.#buildProvisionalPullRequestDetails(action).then(pull => this.#overlayIssueLike(pull, "pull", action.provisionalId, true)))))
      .filter(item => pullMatchesFilter(item, filter))
      .toSorted(compare);
    const injectedItems = [...touched.items, ...provisionals].toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    return new StreamingCursor<GitHubPullRequestSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-pulls", stableKey(filter ?? {}), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubPullRequestSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listPullRequestsConditional(owner, repo, {
            state: filter?.state,
            head: filter?.head
              ? filter.head.includes(":") ? filter.head : `${owner}:${filter.head}`
              : undefined,
            base: filter?.base,
            sort: filter?.sort,
            direction: filter?.direction,
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data
              .filter(item => !touched.ids.has(String(item.number)))
              .map(item => normalizePullSummary(owner, repo, item)),
          };
        });
      },
      overlay: item => this.#overlayIssueLike(item, "pull", item.id),
      filter: item => pullMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  async #searchPullSummaries(query: GitHubPullRequestSearch, pageSize: number): Promise<Cursor<GitHubPullRequestSummary>> {
    const compare = pullComparator("updated", "desc");

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreatePullRequestAction => action.type === "createPullRequest")
      .map(action => this.#buildProvisionalPullRequestDetails(action).then(pull => this.#overlayIssueLike(pull, "pull", action.provisionalId, true)))))
      .filter(item => pullMatchesSearch(item, query))
      .toSorted(compare);

    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    let upstreamPage = 1;
    let upstreamExhausted = false;
    const bufferedMatches: GitHubPullRequestSummary[] = [];
    return new StreamingCursor<GitHubPullRequestSummary>({
      fetchPage: async (_page, perPage) => {
        const matches: GitHubPullRequestSummary[] = [];

        while (matches.length < perPage) {
          while (bufferedMatches.length > 0 && matches.length < perPage) {
            const next = bufferedMatches.shift();
            if (next) {
              matches.push(next);
            }
          }

          if (matches.length >= perPage || upstreamExhausted) {
            break;
          }

          const sourcePage = upstreamPage;
          upstreamPage += 1;
          const cacheKey = this.#cacheKey("search-pulls-source", stableKey(query), `p${sourcePage}`);
          const candidates = await this.#loadCachedWithEtag<GitHubPullRequestResponse[]>(
            cacheKey,
            LIST_CACHE_TTL_MS,
            async etag => {
              const raw = await this.#withApi(api => api.listPullRequestsConditional(owner, repo, {
                state: query.state === "all" ? "all" : query.state ?? "all",
                sort: "updated",
                direction: "desc",
                page: sourcePage,
                per_page: 100,
              }, { ifNoneMatch: etag }));
              if (raw.status === 304) {
                return raw;
              }

              return {
                status: 200,
                headers: raw.headers,
                data: raw.data,
              };
            },
          );

          if (candidates.length < 100) {
            upstreamExhausted = true;
          }

          for (const candidate of candidates) {
            if (pullResponseMatchesSearch(owner, repo, candidate, query)) {
              bufferedMatches.push(normalizePullSummary(owner, repo, candidate));
            }
          }
        }

        return matches;
      },
      overlay: item => this.#overlayIssueLike(item, "pull", item.id),
      filter: () => true,
      comparator: compare,
      injectedItems: provisionals,
      pageSize,
      remotePageSize: pageSize,
    });
  }

  async #getDiscussionCommentPage(realId: string, page: number, perPage: number): Promise<GitHubDiscussionEntry[]> {
    await this.#materializeDiscussionCommentDepth(realId, page * perPage, perPage);
    return this.#readDiscussionCommentSlice(realId, (page - 1) * perPage, perPage);
  }

  async #getDiscussionReviewPage(realId: string, page: number): Promise<GitHubDiscussionEntry[]> {
    const cacheKey = this.#cacheKey("discussion-reviews", realId, `p${page}`);
    return await this.#loadCachedWithEtag<GitHubDiscussionEntry[]>(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
      const raw = await this.#withApi(api =>
        api.listPullRequestReviewsConditional(
          this.ctx.props.owner,
          this.ctx.props.repo,
          Number(realId),
          page,
          100,
          { ifNoneMatch: etag },
        )
      );
      if (raw.status === 304) {
        return raw;
      }

      const commentsByReviewId = new Map<number, GitHubPullRequestReviewCommentResponse[]>();
      for (const comment of await this.#materializeAllPullReviewComments(realId)) {
        const reviewId = comment.pull_request_review_id;
        if (!reviewId) {
          continue;
        }

        const comments = commentsByReviewId.get(reviewId);
        if (comments) {
          comments.push(comment);
        } else {
          commentsByReviewId.set(reviewId, [comment]);
        }
      }

      const normalized = await Promise.all(raw.data.map(async review => {
        const reviewComments = commentsByReviewId.get(review.id) ?? [];
        return {
          kind: "review" as const,
          id: String(review.id),
          author: actorFromUser(review.user),
          bodyMarkdown: review.body ?? "",
          createdAt: new Date(review.submitted_at ?? new Date().toISOString()),
          updatedAt: parseDate(review.submitted_at),
          url: review.html_url,
          decision: reviewDecisionFromState(review.state),
          diffComments: reviewComments.map(comment => ({
            id: String(comment.id),
            threadId: String(comment.in_reply_to_id ?? comment.id),
            target: commentTargetFromResponse(comment),
            author: actorFromUser(comment.user),
            bodyMarkdown: comment.body ?? "",
            createdAt: new Date(comment.created_at),
            updatedAt: parseDate(comment.updated_at),
            url: comment.html_url,
          })),
        };
      }));

      return {
        status: 200,
        headers: raw.headers,
        data: normalized,
      };
    });
  }

  async #getDiscussion(kind: EntityKind, logicalId: string, pageSize: number): Promise<Cursor<GitHubDiscussionEntry>> {
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    const compare = (a: GitHubDiscussionEntry, b: GitHubDiscussionEntry) =>
      a.createdAt.getTime() - b.createdAt.getTime();

    // Build provisional entries from pending actions.
    const viewer = await this.#getViewerActor();
    const provisionals: GitHubDiscussionEntry[] = [];
    for (const action of this.#pendingActionsForEntity(kind, logicalId)) {
      if (action.type === "postComment") {
        provisionals.push({
          kind: "comment",
          id: action.provisionalCommentId,
          author: viewer,
          bodyMarkdown: this.#rewriteKnownReferences(action.bodyMarkdown, false),
          createdAt: new Date(action.submittedAt),
          url: `${kind === "issue" ? issueUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId) : pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#comment-${action.provisionalCommentId}`,
        });
      } else if (action.type === "postReview") {
        provisionals.push({
          kind: "review",
          id: action.provisionalReviewId,
          author: viewer,
          bodyMarkdown: this.#rewriteKnownReferences(action.review.bodyMarkdown ?? "", false),
          createdAt: new Date(action.submittedAt),
          url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#review-${action.provisionalReviewId}`,
          decision: action.review.decision,
          diffComments: (action.review.diffComments ?? []).map(comment => ({
            id: comment.provisionalCommentId,
            threadId: comment.provisionalCommentId,
            target: comment.target,
            author: viewer,
            bodyMarkdown: this.#rewriteKnownReferences(comment.bodyMarkdown, false),
            createdAt: new Date(action.submittedAt),
            url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#discussion-${comment.provisionalCommentId}`,
          })),
        });
      }
    }
    provisionals.sort(compare);

    // Fast path: if there is no real entity yet (pure provisional), return provisionals only.
    if (!realId) {
      return new ArrayCursor(provisionals, pageSize);
    }

    let commentCount = kind === "issue"
      ? (await this.#getRemoteIssueDetails(realId)).commentCount
      : (await this.#getRemotePullRequestDetails(realId)).commentCount;
    const discussionState = this.#ensureDiscussionCommentState(realId, commentCount);
    if (discussionState.depth > commentCount) {
      commentCount = await this.#getLiveTopLevelCommentCount(kind, realId);
    }
    await this.#syncDiscussionComments(realId, commentCount);

    if (kind === "issue") {
      return new StreamingCursor<GitHubDiscussionEntry>({
        fetchPage: async (page, perPage) => await this.#getDiscussionCommentPage(realId, page, perPage),
        overlay: item => item,
        filter: () => true,
        comparator: compare,
        injectedItems: provisionals,
        pageSize,
      });
    }

    // Cache miss: stream discussion entries by merging comment pages and review pages.
    // Stateful closure that merges two sorted streams: comments and reviews.
    let commentPage = 1;
    let reviewPage = 1;
    let commentsDone = false;
    let reviewsDone = false;
    let commentBuf: GitHubDiscussionEntry[] = [];
    let reviewBuf: GitHubDiscussionEntry[] = [];

    const fetchPage = async (_virtualPage: number, perPage: number): Promise<GitHubDiscussionEntry[]> => {
      const result: GitHubDiscussionEntry[] = [];

      while (result.length < perPage) {
        // Refill comment buffer if needed.
        if (commentBuf.length === 0 && !commentsDone) {
          commentBuf = await this.#getDiscussionCommentPage(realId, commentPage, 100);
          commentPage += 1;
          if (commentBuf.length < 100) commentsDone = true;
        }

        // Refill review buffer if needed.
        if (reviewBuf.length === 0 && !reviewsDone) {
          reviewBuf = await this.#getDiscussionReviewPage(realId, reviewPage++);
          if (reviewBuf.length < 100) reviewsDone = true;
        }

        // Both sources empty → done.
        if (commentBuf.length === 0 && reviewBuf.length === 0) break;

        // Take the entry with the earlier createdAt.
        let next: GitHubDiscussionEntry | undefined;
        if (commentBuf.length === 0) {
          next = reviewBuf.shift();
        } else if (reviewBuf.length === 0) {
          next = commentBuf.shift();
        } else if (commentBuf[0].createdAt.getTime() <= reviewBuf[0].createdAt.getTime()) {
          next = commentBuf.shift();
        } else {
          next = reviewBuf.shift();
        }

        if (!next) {
          break;
        }
        result.push(next);
      }
      return result;
    };

    return new StreamingCursor<GitHubDiscussionEntry>({
      fetchPage,
      overlay: item => item, // No per-entry simulation overlay for discussion entries.
      filter: () => true,
      comparator: compare,
      injectedItems: provisionals,
      pageSize,
    });
  }

  /**
   * Accumulate all review comments for a specific review. This is bounded by the
   * number of comments on a single review (typically small).
   */
  async #accumulateReviewComments(realId: string, reviewId: number): Promise<GitHubPullRequestReviewCommentResponse[]> {
    const reviewCommentState = this.#getPullReviewCommentState(realId);
    if (reviewCommentState?.exhausted) {
      await this.#syncPullReviewComments(realId);
      return this.#readAllPullReviewComments(realId)
        .filter(comment => comment.pull_request_review_id === reviewId);
    }

    const cacheKey = this.#cacheKey("discussion-review-comments", realId, String(reviewId));
    return await this.#loadCachedWithEtag<GitHubPullRequestReviewCommentResponse[]>(
      cacheKey,
      ENTITY_CACHE_TTL_MS,
      async etag => {
        const firstPage = await this.#withApi(api =>
          api.listReviewCommentsForReviewConditional(
            this.ctx.props.owner,
            this.ctx.props.repo,
            Number(realId),
            reviewId,
            1,
            100,
            { ifNoneMatch: etag },
          )
        );
        if (firstPage.status === 304) {
          return firstPage;
        }

        const results = [...firstPage.data];
        if (firstPage.data.length === 100) {
          const rest = await this.#fetchAllPages((page, perPage) =>
            this.#withApi(api =>
              api.listReviewCommentsForReview(
                this.ctx.props.owner,
                this.ctx.props.repo,
                Number(realId),
                reviewId,
                page + 1,
                perPage,
              )));
          results.push(...rest);
        }

        return {
          status: 200,
          headers: firstPage.headers,
          data: results,
        };
      },
    );
  }

  async #getDiff(logicalId: string, pageSize: number): Promise<{ revision: GitHubPullRequestRevision; files: Cursor<GitHubPullRequestDiffFile> }> {
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      const cacheKey = this.#cacheKey("diff-provisional", logicalId);
      const cached = await this.#loadCachedWithEtag<{ revision: GitHubPullRequestRevision; files: GitHubPullRequestDiffFile[] }>(
        cacheKey,
        ENTITY_CACHE_TTL_MS,
        async etag => {
          const comparison = await this.#withApi(api =>
            api.compareBranchesConditional(
              this.ctx.props.owner,
              this.ctx.props.repo,
              action.options.base,
              action.options.head,
              { ifNoneMatch: etag },
            )
          );
          if (comparison.status === 304) {
            return comparison;
          }

          const revision = {
            baseSha: comparison.data.base_commit.sha,
            headSha: comparison.data.commits?.at(-1)?.sha ?? comparison.data.base_commit.sha,
          };
          return {
            status: 200,
            headers: comparison.headers,
            data: {
              revision,
              files: (comparison.data.files ?? []).map(file => this.#normalizeDiffFile(file)),
            },
          };
        },
      );
      return { revision: cached.revision, files: new ArrayCursor(cached.files, pageSize) };
    }

    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    const details = await this.#getRemotePullRequestDetails(realId);
    const revision = {
      baseSha: details.base.sha,
      headSha: details.head.sha,
    };
    const cacheKey = this.#cacheKey("diff", realId, revision.baseSha || "pending", revision.headSha || "pending");
    const cached = this.#loadCached<{ revision: GitHubPullRequestRevision; files: GitHubPullRequestDiffFile[] }>(cacheKey, ENTITY_CACHE_TTL_MS);
    if (cached) {
      return { revision: cached.revision, files: new ArrayCursor(cached.files, pageSize) };
    }

    const allFiles: GitHubPullRequestDiffFile[] = [];

    return {
      revision,
      files: new StreamingCursor<GitHubPullRequestDiffFile>({
        fetchPage: async (page, perPage) => {
          const pageCacheKey = this.#cacheKey("diff-files", realId, revision.baseSha || "pending", revision.headSha || "pending", `p${page}`);
          const normalized = await this.#loadCachedWithEtag<GitHubPullRequestDiffFile[]>(
            pageCacheKey,
            ENTITY_CACHE_TTL_MS,
            async etag => {
              const raw = await this.#withApi(api =>
                api.listPullRequestFilesConditional(
                  this.ctx.props.owner,
                  this.ctx.props.repo,
                  Number(realId),
                  page,
                  perPage,
                  { ifNoneMatch: etag },
                )
              );
              if (raw.status === 304) {
                return raw;
              }

              return {
                status: 200,
                headers: raw.headers,
                data: raw.data.map(file => this.#normalizeDiffFile(file)),
              };
            },
          );
          allFiles.push(...normalized);
          if (normalized.length < perPage) {
            this.#storeCached(cacheKey, { revision, files: allFiles });
          }
          return normalized;
        },
        overlay: item => item,
        filter: () => true,
        comparator: () => 0,
        injectedItems: [],
        pageSize,
      }),
    };
  }

  #normalizeDiffFile(file: GitHubPullFileResponse): GitHubPullRequestDiffFile {
    return {
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      // GitHub omits `patch` for binary files and for large text diffs.
      diffOmitted: !file.patch,
      hunks: file.patch ? parsePatch(file.patch) : [],
    };
  }

  async #getDiffThreads(logicalId: string, pageSize: number): Promise<Cursor<GitHubDiffThread>> {
    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId) : logicalId;
    let base: GitHubDiffThread[] = [];
    if (realId) {
      base = await this.#fetchRemoteDiffThreads(realId);
    }

    const threads = new Map<string, GitHubDiffThread>(base.map(thread => [thread.id, structuredClone(thread)]));
    const viewer = await this.#getViewerActor();
    for (const action of this.#pendingActionsForEntity("pull", logicalId)) {
      if (action.type === "postReview") {
        for (const comment of action.review.diffComments ?? []) {
          threads.set(comment.provisionalCommentId, {
            id: comment.provisionalCommentId,
            target: comment.target,
            isOutdated: false,
            comments: [{
              id: comment.provisionalCommentId,
              reviewId: action.provisionalReviewId,
              author: viewer,
              bodyMarkdown: this.#rewriteKnownReferences(comment.bodyMarkdown, false),
              createdAt: new Date(action.submittedAt),
              url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#discussion-${comment.provisionalCommentId}`,
            }],
          });
        }
      } else if (action.type === "replyToDiffComment") {
        const thread = [...threads.values()].find(candidate =>
          candidate.id === action.commentId || candidate.comments.some(comment => comment.id === action.commentId),
        );
        if (thread) {
          thread.comments.push({
            id: action.provisionalCommentId,
            author: viewer,
            bodyMarkdown: this.#rewriteKnownReferences(action.bodyMarkdown, false),
            createdAt: new Date(action.submittedAt),
            url: `${pullUrl(this.ctx.props.owner, this.ctx.props.repo, logicalId)}#discussion-${action.provisionalCommentId}`,
          });
        }
      }
    }

    const sorted = [...threads.values()].toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
    return new ArrayCursor(sorted, pageSize);
  }

  /**
   * Fetch all review comments for a PR and group them into threads. Grouping requires
   * seeing all comments (replies may reference comments from different pages), so this
   * accumulates all pages before grouping.
   */
  async #fetchRemoteDiffThreads(realId: string): Promise<GitHubDiffThread[]> {
    await this.#syncPullReviewComments(realId);
    const comments = await this.#materializeAllPullReviewComments(realId);

    const byThread = new Map<string, GitHubDiffThread>();
    for (const comment of comments) {
      const threadId = String(comment.in_reply_to_id ?? comment.id);
      let thread = byThread.get(threadId);
      if (!thread) {
        thread = {
          id: threadId,
          target: commentTargetFromResponse(comment),
          isOutdated: comment.position == null && comment.original_position != null,
          comments: [],
        };
        byThread.set(threadId, thread);
      }

      thread.comments.push({
        id: String(comment.id),
        reviewId: comment.pull_request_review_id ? String(comment.pull_request_review_id) : undefined,
        author: actorFromUser(comment.user),
        bodyMarkdown: comment.body ?? "",
        createdAt: new Date(comment.created_at),
        updatedAt: parseDate(comment.updated_at),
        url: comment.html_url,
      });
    }

    return [...byThread.values()].toSorted((a, b) => a.comments[0].createdAt.getTime() - b.comments[0].createdAt.getTime());
  }

  async describe(): Promise<ResourceDescription> {
    switch (this.ctx.props.resourceKind) {
      case "repo": {
        const repo = await this.#getRepoMetadata();
        return {
          url: repo.url,
          title: repo.fullName,
          snippet: repo.description ?? `GitHub repository ${repo.fullName}`,
          suggestedBindingName: "GITHUB_REPO",
          tsType: "GitHubRepo",
        };
      }
      case "issue": {
        const issue = await this.#getIssueDetails(String(this.ctx.props.issueNumber));
        return {
          url: issue.url,
          title: `Issue #${issue.id}: ${issue.title}`,
          snippet: textSnippet(issue.bodyMarkdown, `${issue.state} issue in ${issue.repo.fullName}`),
          suggestedBindingName: "GITHUB_ISSUE",
          tsType: "GitHubIssue",
        };
      }
      case "pull": {
        const pull = await this.#getPullRequestDetails(String(this.ctx.props.issueNumber));
        return {
          url: pull.url,
          title: `Pull Request #${pull.id}: ${pull.title}`,
          snippet: textSnippet(pull.bodyMarkdown, `${pull.state} pull request in ${pull.repo.fullName}`),
          suggestedBindingName: "GITHUB_PULL_REQUEST",
          tsType: "GitHubPullRequest",
        };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async submitActionForApproval(
    approvalQueue: RpcStub<ApprovalQueue>,
    action: GitHubAction,
    description: ActionDescription,
  ): Promise<void> {
    this.#stageAction(action);
    try {
      await approvalQueue.submitAction(action.approvalId, description);
    } catch (error) {
      this.ctx.storage.kv.delete(this.#actionRecordKey(action.approvalId));
      this.#pendingActionsCache = undefined;
      throw error;
    }

    this.#markActionPending(action);
    this.#clearCaches();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GitHubRepoSession | GitHubIssue | GitHubPullRequest> {
    const queue = approvalQueue.dup();
    switch (this.ctx.props.resourceKind) {
      case "repo":
        return new GitHubRepoSessionImpl(this, queue);
      case "issue":
        return new GitHubIssueImpl(this, queue, String(this.ctx.props.issueNumber), "issue");
      case "pull":
        return new GitHubPullRequestImpl(this, queue, String(this.ctx.props.issueNumber));
    }
  }

  async applyAction(actionId: number): Promise<void> {
    const record = this.#requireActionRecord(actionId);
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`GitHub action ${actionId} is no longer pending.`);
    }

    const action = record.action;
    switch (action.type) {
      case "createIssue": {
        const response = await this.#withApi(api => api.createIssue(action.owner, action.repo, {
          title: action.options.title,
          body: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
          labels: action.options.labels,
          assignees: action.options.assignees,
        }));
        this.#setProvisionalResource(action.provisionalId, { kind: "issue", realId: String(response.number) });
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "createPullRequest": {
        const response = await this.#withApi(api => api.createPullRequest(action.owner, action.repo, {
          title: action.options.title,
          body: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
          head: action.options.head,
          base: action.options.base,
          draft: action.options.draft,
        }));
        this.#setProvisionalResource(action.provisionalId, { kind: "pull", realId: String(response.number) });
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "setTitle": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), { title: action.title }));
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "setBody": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), {
          body: this.#rewriteKnownReferences(action.bodyMarkdown, true),
        }));
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "addLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.addLabels(action.owner, action.repo, Number(realId), action.labels));
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "removeLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => {
          const remainingLabels = action.previousLabels.filter(
            label => !action.labels.some(removed => removed.toLowerCase() === label.toLowerCase()),
          );
          return api.setLabels(action.owner, action.repo, Number(realId), remainingLabels);
        });
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "changeState": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), {
          state: action.state,
          state_reason: denormalizeStateReason(action.reason),
        }));
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "postComment": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) throw new Error(`Target ${action.targetId} has not been created on GitHub yet.`);
        const response = await this.#withApi(api => api.createIssueComment(
          action.owner,
          action.repo,
          Number(realId),
          this.#rewriteKnownReferences(action.bodyMarkdown, true),
        ));
        const revertInfo: GitHubRevertInfo = {
          type: "issueComment",
          commentId: response.id,
        };
        this.#markActionApproved(action, revertInfo);
        this.#clearCaches();
        return;
      }
      case "postReview": {
        const realId = action.pullId.startsWith("~") ? this.#resolveProvisionalId(action.pullId) : action.pullId;
        if (!realId) throw new Error(`Pull request ${action.pullId} has not been created on GitHub yet.`);
        const review = await this.#withApi(api => api.createPullRequestReview(action.owner, action.repo, Number(realId), {
          commit_id: action.review.revision.headSha,
          body: action.review.bodyMarkdown ? this.#rewriteKnownReferences(action.review.bodyMarkdown, true) : undefined,
          event: action.review.decision === "approve"
            ? "APPROVE"
            : action.review.decision === "requestChanges"
              ? "REQUEST_CHANGES"
              : "COMMENT",
          comments: action.review.diffComments?.map(comment => ({
            path: comment.target.path,
            body: this.#rewriteKnownReferences(comment.bodyMarkdown, true),
            line: comment.target.subjectType === "file" ? undefined : comment.target.line,
            side: comment.target.subjectType === "file" ? undefined : comment.target.side === "old" ? "LEFT" : "RIGHT",
            start_line: comment.target.subjectType === "file" ? undefined : comment.target.startLine,
            start_side: comment.target.subjectType === "file" || !comment.target.startSide
              ? undefined
              : comment.target.startSide === "old" ? "LEFT" : "RIGHT",
            subject_type: comment.target.subjectType,
          })),
        }));

        if (action.review.diffComments && action.review.diffComments.length > 0) {
          const createdComments = await this.#accumulateReviewComments(realId, review.id);
          const createdBySignature = new Map<string, GitHubPullRequestReviewCommentResponse[]>();
          for (const createdComment of createdComments) {
            const signature = reviewCommentSignature(createdComment);
            const bucket = createdBySignature.get(signature);
            if (bucket) {
              bucket.push(createdComment);
            } else {
              createdBySignature.set(signature, [createdComment]);
            }
          }

          for (const comment of action.review.diffComments) {
            const signature = diffCommentSignature(
              comment.target,
              this.#rewriteKnownReferences(comment.bodyMarkdown, true),
            );
            const created = createdBySignature.get(signature)?.shift();
            if (created) {
              this.ctx.storage.kv.put(`diffAlias:${comment.provisionalCommentId}`, String(created.id));
            }
          }
        }

        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
      case "replyToDiffComment": {
        const pullId = action.pullId.startsWith("~") ? this.#resolveProvisionalId(action.pullId) : action.pullId;
        if (!pullId) throw new Error(`Pull request ${action.pullId} has not been created on GitHub yet.`);
        const replyTargetId = await this.#resolveReplyTarget(action.commentId);
        const response = await this.#withApi(api => api.replyToPullRequestReviewComment(
          action.owner,
          action.repo,
          Number(pullId),
          replyTargetId,
          this.#rewriteKnownReferences(action.bodyMarkdown, true),
        ));
        this.ctx.storage.kv.put(`diffAlias:${action.provisionalCommentId}`, String(response.id));
        const revertInfo: GitHubRevertInfo = {
          type: "reviewComment",
          commentId: response.id,
        };
        this.#markActionApproved(action, revertInfo);
        this.#clearCaches();
        return;
      }
      case "mergePullRequest": {
        const pullId = action.pullId.startsWith("~") ? this.#resolveProvisionalId(action.pullId) : action.pullId;
        if (!pullId) throw new Error(`Pull request ${action.pullId} has not been created on GitHub yet.`);
        await this.#withApi(api => api.mergePullRequest(action.owner, action.repo, Number(pullId), {
          merge_method: action.options?.method,
          commit_title: action.options?.commitTitle,
          commit_message: action.options?.commitMessage,
          sha: action.options?.expectedHeadSha,
        }));
        this.#markActionApproved(action);
        this.#clearCaches();
        return;
      }
    }
  }

  async #resolveReplyTarget(commentId: string): Promise<number> {
    const pendingReplies = new Map(
      this.#listPendingActions()
        .filter((action): action is ReplyToDiffCommentAction => action.type === "replyToDiffComment")
        .map(action => [action.provisionalCommentId, action]),
    );

    let resolvedCommentId = commentId;
    const seen = new Set<string>();
    while (pendingReplies.has(resolvedCommentId)) {
      if (seen.size >= MAX_REPLY_TARGET_HOPS) {
        throw new Error(`Reply chain for diff comment ${commentId} exceeded ${MAX_REPLY_TARGET_HOPS} hops.`);
      }
      if (seen.has(resolvedCommentId)) {
        throw new Error(`Reply chain for diff comment ${commentId} contains a cycle.`);
      }

      seen.add(resolvedCommentId);
      const pendingReply = pendingReplies.get(resolvedCommentId);
      if (!pendingReply) {
        break;
      }
      resolvedCommentId = pendingReply.commentId;
    }

    const aliased = this.ctx.storage.kv.get<string>(`diffAlias:${resolvedCommentId}`) ?? resolvedCommentId;
    if (!/^\d+$/.test(aliased)) {
      throw new Error(`Diff comment ${resolvedCommentId} has not been created on GitHub yet.`);
    }

    const comment = await this.#withApi(api => api.getPullRequestReviewComment(
      this.ctx.props.owner,
      this.ctx.props.repo,
      Number(aliased),
    ));
    return comment.in_reply_to_id ?? comment.id;
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    if (record.state !== "pending" && record.state !== "staged") {
      throw new Error(`GitHub action ${actionId} is no longer pending.`);
    }

    this.#markActionRejected(action);
    if (action.type === "createIssue" || action.type === "createPullRequest") {
      this.#rejectActionsForResource(action.type === "createIssue" ? "issue" : "pull", action.provisionalId);
      this.ctx.storage.kv.delete(`provisional:${action.provisionalId}`);
      this.#clearCaches();
      return { restart: true };
    }

    if (action.type === "postReview") {
      this.#rejectReplyDependencyChain((action.review.diffComments ?? []).map(comment => comment.provisionalCommentId));
    } else if (action.type === "replyToDiffComment") {
      this.#rejectReplyDependencyChain([action.provisionalCommentId]);
    }

    this.#clearCaches();
    return;
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const record = this.#requireActionRecord(actionId);
    const action = record.action;
    const revertInfo = record.revertInfo;
    switch (action.type) {
      case "setTitle": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), { title: action.previousTitle }));
        this.#clearCaches();
        return;
      }
      case "setBody": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), { body: action.previousBodyMarkdown }));
        this.#clearCaches();
        return;
      }
      case "addLabels":
      case "removeLabels": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.setLabels(action.owner, action.repo, Number(realId), action.previousLabels));
        this.#clearCaches();
        return;
      }
      case "changeState": {
        const realId = action.targetId.startsWith("~") ? this.#resolveProvisionalId(action.targetId) : action.targetId;
        if (!realId) return { message: "The target resource no longer exists on GitHub.", canRetry: false };
        await this.#withApi(api => api.updateIssue(action.owner, action.repo, Number(realId), {
          state: action.previousState,
          state_reason: denormalizeStateReason(action.previousReason),
        }));
        this.#clearCaches();
        return;
      }
      case "postComment": {
        if (revertInfo?.type !== "issueComment") {
          return { message: "Missing issue comment revert information.", canRetry: false };
        }
        await this.#withApi(api => api.deleteIssueComment(action.owner, action.repo, revertInfo.commentId));
        this.#clearCaches();
        return;
      }
      case "replyToDiffComment": {
        if (revertInfo?.type !== "reviewComment") {
          return { message: "Missing review comment revert information.", canRetry: false };
        }
        await this.#withApi(api => api.deletePullRequestReviewComment(action.owner, action.repo, revertInfo.commentId));
        this.#clearCaches();
        return;
      }
      case "createIssue":
      case "createPullRequest":
      case "postReview":
      case "mergePullRequest":
        return {
          message: "This GitHub action cannot be automatically reverted.",
          canRetry: false,
        };
    }
  }

  async repoMetadata(): Promise<GitHubRepoMetadata> {
    return this.#getRepoMetadata();
  }

  async openIssue(id: string): Promise<GitHubIssueDetails> {
    return this.#getIssueDetails(id);
  }

  async openPullRequest(id: string): Promise<GitHubPullRequestDetails> {
    return this.#getPullRequestDetails(id);
  }

  async issueDiscussion(kind: EntityKind, id: string, pageSize: number): Promise<Cursor<GitHubDiscussionEntry>> {
    return this.#getDiscussion(kind, id, pageSize);
  }

  async pullDiff(id: string, pageSize: number): Promise<{ revision: GitHubPullRequestRevision; files: Cursor<GitHubPullRequestDiffFile> }> {
    return this.#getDiff(id, pageSize);
  }

  async pullThreads(id: string, pageSize: number): Promise<Cursor<GitHubDiffThread>> {
    return this.#getDiffThreads(id, pageSize);
  }

  async listIssues(filter: GitHubIssueFilter | undefined, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    return this.#listIssueSummaries(filter, pageSize);
  }

  async searchIssues(query: GitHubIssueSearch, pageSize: number): Promise<Cursor<GitHubIssueSummary>> {
    return this.#searchIssueSummaries(query, pageSize);
  }

  async listPullRequests(filter: GitHubPullRequestFilter | undefined, pageSize: number): Promise<Cursor<GitHubPullRequestSummary>> {
    return this.#listPullSummaries(filter, pageSize);
  }

  async searchPullRequests(query: GitHubPullRequestSearch, pageSize: number): Promise<Cursor<GitHubPullRequestSummary>> {
    return this.#searchPullSummaries(query, pageSize);
  }

  async prepareCreateIssue(options: GitHubCreateIssueOptions): Promise<CreateIssueAction> {
    return {
      type: "createIssue",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      provisionalId: this.#nextProvisionalResourceId(),
      options,
    };
  }

  async prepareCreatePullRequest(options: GitHubCreatePullRequestOptions): Promise<CreatePullRequestAction> {
    return {
      type: "createPullRequest",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      provisionalId: this.#nextProvisionalResourceId(),
      options,
    };
  }

  async prepareSetTitle(targetKind: EntityKind, targetId: string, title: string): Promise<SetTitleAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "setTitle",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      title,
      previousTitle: details.title,
    };
  }

  async prepareSetBody(targetKind: EntityKind, targetId: string, bodyMarkdown: string): Promise<SetBodyAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "setBody",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      bodyMarkdown,
      previousBodyMarkdown: details.bodyMarkdown,
    };
  }

  async prepareAddLabels(targetKind: EntityKind, targetId: string, labels: string[]): Promise<AddLabelsAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "addLabels",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      labels,
      previousLabels: details.labels.map(label => label.name),
    };
  }

  async prepareRemoveLabels(targetKind: EntityKind, targetId: string, labels: string[]): Promise<RemoveLabelsAction> {
    const details = targetKind === "issue" ? await this.#getIssueDetails(targetId) : await this.#getPullRequestDetails(targetId);
    return {
      type: "removeLabels",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      labels,
      previousLabels: details.labels.map(label => label.name),
    };
  }

  async prepareChangeState(
    targetKind: EntityKind,
    targetId: string,
    state: GitHubIssueState,
    reason?: "completed" | "notPlanned",
  ): Promise<ChangeStateAction> {
    const current = await this.#getCurrentStateInfo(targetKind, targetId);
    return {
      type: "changeState",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      state,
      reason,
      previousState: current.state,
      previousReason: current.reason,
    };
  }

  async preparePostComment(targetKind: EntityKind, targetId: string, bodyMarkdown: string): Promise<PostCommentAction> {
    return {
      type: "postComment",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      targetKind,
      targetId,
      bodyMarkdown,
      provisionalCommentId: this.#nextProvisionalCommentId("comment"),
    };
  }

  async preparePostReview(pullId: string, review: GitHubPullRequestReviewDraft): Promise<PostReviewAction> {
    return {
      type: "postReview",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      pullId,
      provisionalReviewId: this.#nextProvisionalCommentId("review"),
      review: {
        ...review,
        diffComments: review.diffComments?.map(comment => ({
          ...comment,
          provisionalCommentId: this.#nextProvisionalCommentId("diff"),
        })),
      },
    };
  }

  async prepareReplyToDiffComment(pullId: string, commentId: string, bodyMarkdown: string): Promise<ReplyToDiffCommentAction> {
    return {
      type: "replyToDiffComment",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      pullId,
      commentId,
      bodyMarkdown,
      provisionalCommentId: this.#nextProvisionalCommentId("reply"),
    };
  }

  async prepareMergePullRequest(pullId: string, options?: GitHubPullRequestMergeOptions): Promise<MergePullRequestAction> {
    return {
      type: "mergePullRequest",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      pullId,
      options,
    };
  }

  /**
   * Observer tracking: GitHub uses the "ACL check (single unit)" strategy. Every binding — repo,
   * issue, or pull request — is scoped to one repository, and issues/PRs inherit the repo's
   * permissions, so the repository is the atomic ACL unit. To admit an observer we simply confirm
   * they can read that repo, using their own token via the verifier (see GitHubVerifier).
   *
   * Because the whole unit is verified up front, there is never a later observation a verified
   * observer shouldn't see, so we set no excludeObservers and need not remember observers;
   * removeObserver is an idempotent no-op. The overseer re-runs addObserver on every open, so loss
   * of the observer's repo access is caught promptly.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<GitHubVerifierApi>;
    const { owner, repo } = this.ctx.props;
    if (!(await verifier.hasRepoAccess(owner, repo))) {
      throw new Error(
        `This collaborator does not have read access to the GitHub repository ${owner}/${repo}, ` +
        `so they cannot be allowed to observe data this workspace read from it.`);
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}

@validateRpc()
class GitHubRepoSessionImpl extends RpcTarget implements GitHubRepoSession {
  #gatekeeper: GitHubGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;

  constructor(gatekeeper: GitHubGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
  }

  [Symbol.dispose](): void {
    (this.#approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async getMetadata(): Promise<GitHubRepoMetadata> {
    const metadata = await this.#gatekeeper.repoMetadata();
    await this.#approvalQueue.authorizeObservation({
      title: `Read repository metadata for ${metadata.fullName}`,
      description: `Read basic metadata for the GitHub repository ${metadata.fullName}.`,
    });
    return metadata;
  }

  async createIssue(options: GitHubCreateIssueOptions): Promise<GitHubIssue> {
    const action = await this.#gatekeeper.prepareCreateIssue(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create issue ${options.title}`,
      description: `Create a new issue in ${action.owner}/${action.repo} titled "${options.title}".`,
      implementsRevert: false,
    });
    return new GitHubIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId, "issue");
  }

  async createPullRequest(options: GitHubCreatePullRequestOptions): Promise<GitHubPullRequest> {
    const action = await this.#gatekeeper.prepareCreatePullRequest(options);
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Create pull request ${options.title}`,
      description: `Create a new pull request in ${action.owner}/${action.repo} from ${options.head} into ${options.base}.`,
      implementsRevert: false,
    });
    return new GitHubPullRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), action.provisionalId);
  }

  async getIssue(id: string): Promise<GitHubIssue> {
    const details = await this.#gatekeeper.openIssue(id);
    await this.#approvalQueue.authorizeObservation({
      title: `Open issue #${details.id}: ${details.title}`,
      description: `Open a capability for issue #${details.id} in ${details.repo.fullName}.`,
    });
    return new GitHubIssueImpl(this.#gatekeeper, this.#approvalQueue.dup(), id, "issue");
  }

  async getPullRequest(id: string): Promise<GitHubPullRequest> {
    const details = await this.#gatekeeper.openPullRequest(id);
    await this.#approvalQueue.authorizeObservation({
      title: `Open pull request #${details.id}: ${details.title}`,
      description: `Open a capability for pull request #${details.id} in ${details.repo.fullName}.`,
    });
    return new GitHubPullRequestImpl(this.#gatekeeper, this.#approvalQueue.dup(), id);
  }

  async listIssues(options?: GitHubIssueFilter): Promise<Cursor<GitHubIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List issues`,
      description: `List issues in the GitHub repository.`,
    });
    return this.#gatekeeper.listIssues(options, options?.resultsPerPage ?? 50);
  }

  async searchIssues(query: GitHubIssueSearch): Promise<Cursor<GitHubIssueSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search issues for "${query.text}"`,
      description: `Search issues in the GitHub repository for "${query.text}".`,
    });
    return this.#gatekeeper.searchIssues(query, query.resultsPerPage ?? 50);
  }

  async listPullRequests(options?: GitHubPullRequestFilter): Promise<Cursor<GitHubPullRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List pull requests`,
      description: `List pull requests in the GitHub repository.`,
    });
    return this.#gatekeeper.listPullRequests(options, options?.resultsPerPage ?? 50);
  }

  async searchPullRequests(query: GitHubPullRequestSearch): Promise<Cursor<GitHubPullRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search pull requests for "${query.text}"`,
      description: `Search pull requests in the GitHub repository for "${query.text}".`,
    });
    return this.#gatekeeper.searchPullRequests(query, query.resultsPerPage ?? 50);
  }
}

@validateRpc()
class GitHubIssueImpl extends RpcTarget implements GitHubIssue {
  protected gatekeeper: GitHubGatekeeperImpl;
  protected approvalQueue: RpcStub<ApprovalQueue>;
  protected logicalId: string;
  protected kind: EntityKind;

  constructor(
    gatekeeper: GitHubGatekeeperImpl,
    approvalQueue: RpcStub<ApprovalQueue>,
    logicalId: string,
    kind: EntityKind,
  ) {
    super();
    this.gatekeeper = gatekeeper;
    this.approvalQueue = approvalQueue;
    this.logicalId = logicalId;
    this.kind = kind;
  }

  [Symbol.dispose](): void {
    (this.approvalQueue as RpcStub<ApprovalQueue> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  protected async authorizeMutationPreparation(action: string): Promise<void> {
    await this.approvalQueue.authorizeObservation({
      title: `Read current state of #${this.logicalId}`,
      description: `Read the current state of #${this.logicalId} in order to ${action} and capture revert information.`,
    });
  }

  async getDetails(): Promise<GitHubIssueDetails> {
    const details = await this.gatekeeper.openIssue(this.logicalId);
    await this.approvalQueue.authorizeObservation({
      title: `Read issue #${details.id}: ${details.title}`,
      description: `Read the full details of issue #${details.id} in ${details.repo.fullName}.`,
    });
    return details;
  }

  async setTitle(title: string): Promise<void> {
    await this.authorizeMutationPreparation("change its title");
    const action = await this.gatekeeper.prepareSetTitle(this.kind, this.logicalId, title);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Rename #${this.logicalId}`,
      description: `Change the title from "${action.previousTitle}" to "${title}".`,
      implementsRevert: true,
    });
  }

  async setBody(bodyMarkdown: string): Promise<void> {
    await this.authorizeMutationPreparation("edit its body");
    const action = await this.gatekeeper.prepareSetBody(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Edit body of #${this.logicalId}`,
      description: `Replace the Markdown body of #${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async addLabels(labels: string[]): Promise<void> {
    await this.authorizeMutationPreparation("add labels");
    const action = await this.gatekeeper.prepareAddLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Add labels to #${this.logicalId}`,
      description: `Add labels ${labels.join(", ")} to #${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async removeLabels(labels: string[]): Promise<void> {
    await this.authorizeMutationPreparation("remove labels");
    const action = await this.gatekeeper.prepareRemoveLabels(this.kind, this.logicalId, labels);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Remove labels from #${this.logicalId}`,
      description: `Remove labels ${labels.join(", ")} from #${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async close(reason?: "completed" | "notPlanned"): Promise<void> {
    await this.authorizeMutationPreparation("close it");
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "closed", reason);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Close #${this.logicalId}`,
      description: `Close #${this.logicalId}${reason ? ` with reason ${reason}` : ""}.`,
      implementsRevert: true,
    });
  }

  async reopen(): Promise<void> {
    await this.authorizeMutationPreparation("reopen it");
    const action = await this.gatekeeper.prepareChangeState(this.kind, this.logicalId, "open");
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reopen #${this.logicalId}`,
      description: `Reopen #${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async readDiscussion(options?: GitHubPageOptions): Promise<Cursor<GitHubDiscussionEntry>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read discussion for #${this.logicalId}`,
      description: `Read the discussion thread for #${this.logicalId}.`,
    });
    return this.gatekeeper.issueDiscussion(this.kind, this.logicalId, options?.resultsPerPage ?? 50);
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    const action = await this.gatekeeper.preparePostComment(this.kind, this.logicalId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Comment on #${this.logicalId}`,
      description: `Post a new Markdown comment on #${this.logicalId}.`,
      implementsRevert: true,
    });
  }
}

@validateRpc()
class GitHubPullRequestImpl extends GitHubIssueImpl implements GitHubPullRequest {
  constructor(gatekeeper: GitHubGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, logicalId: string) {
    super(gatekeeper, approvalQueue, logicalId, "pull");
  }

  async getDetails(): Promise<GitHubPullRequestDetails> {
    const details = await this.gatekeeper.openPullRequest(this.logicalId);
    await this.approvalQueue.authorizeObservation({
      title: `Read pull request #${details.id}: ${details.title}`,
      description: `Read the full details of pull request #${details.id} in ${details.repo.fullName}.`,
    });
    return details;
  }

  async readDiff(options?: GitHubPageOptions): Promise<GitHubPullRequestDiff> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff for #${this.logicalId}`,
      description: `Read the diff for pull request #${this.logicalId}.`,
    });
    return this.gatekeeper.pullDiff(this.logicalId, options?.resultsPerPage ?? 20);
  }

  async readDiffThreads(options?: GitHubPageOptions): Promise<Cursor<GitHubDiffThread>> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff threads for #${this.logicalId}`,
      description: `Read diff discussion threads for pull request #${this.logicalId}.`,
    });
    return this.gatekeeper.pullThreads(this.logicalId, options?.resultsPerPage ?? 20);
  }

  async postReview(review: GitHubPullRequestReviewDraft): Promise<void> {
    const action = await this.gatekeeper.preparePostReview(this.logicalId, review);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Submit review for #${this.logicalId}`,
      description: `Submit a ${review.decision} review for pull request #${this.logicalId}.`,
      implementsRevert: false,
    });
  }

  async replyToDiffComment(commentId: string, bodyMarkdown: string): Promise<void> {
    if (commentId.startsWith("~")) {
      throw new Error(
        "Replies to provisional diff comments are not supported until the parent review is approved and GitHub assigns real comment IDs.",
      );
    }
    const action = await this.gatekeeper.prepareReplyToDiffComment(this.logicalId, commentId, bodyMarkdown);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Reply to diff thread on #${this.logicalId}`,
      description: `Reply to a diff discussion thread on pull request #${this.logicalId}.`,
      implementsRevert: true,
    });
  }

  async merge(options?: GitHubPullRequestMergeOptions): Promise<void> {
    const action = await this.gatekeeper.prepareMergePullRequest(this.logicalId, options);
    await this.gatekeeper.submitActionForApproval(this.approvalQueue, action, {
      title: `Merge pull request #${this.logicalId}`,
      description: `Merge pull request #${this.logicalId}${options?.method ? ` using ${options.method}` : ""}.`,
      implementsRevert: false,
    });
  }
}
