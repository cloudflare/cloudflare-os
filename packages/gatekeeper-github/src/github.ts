import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type ActionDescription,
  type AccountDescription,
  type ConnectHandoff,
  type Cursor,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type GitCache,
  type GitOid,
  type GitPullHints,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { commitStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import {
  GitHubApi,
  GitHubApiError,
  exchangeAuthCode,
  revokeOAuthGrant,
  type ConditionalRequestResult,
  type GitHubCompareResponse,
  type GitHubIssueCommentResponse,
  type GitHubIssueResponse,
  type GitHubLabelResponse,
  type GitHubPullFileResponse,
  type GitHubPullRequestResponse,
  type GitHubPullRequestReviewCommentResponse,
} from "./github-api";
import { assertIssueSearchResultsInRepo, buildIssueSearchQuery } from "./github-search";
import {
  actorFromUser,
  advertiseCommits,
  commitDetailsFromGitObject,
  commitIdsOfPullSummary,
  commitIdsOfSummary,
  CommitAdvertisingCursor,
  isCommitOid,
  normalizeBranchSummary,
  normalizeCommitDetails,
  normalizeCommitSummary,
  normalizeTagSummary,
  parseGitCommitPayload,
} from "./git-commits";
import {
  MAX_DIFF_BLOB_BYTES,
  changedPathsBetweenTrees,
  diffGitTrees,
  parseGitTreePayload,
  type TreeDiffSource,
} from "./git-diff";
import {
  GitRefUpdateRejectedError,
  ZERO_OID,
  emptyPackBytes,
  pullGitObjectsIntoCache,
  pushGitRefUpdate,
  validateBranchName,
} from "./git-transport";
import GITHUB_LOGO_SVG from "./github-logo.svg";
import type {
  GitHubActor,
  GitHubBranchFilter,
  GitHubBranchSummary,
  GitHubCommitDetails,
  GitHubCommitFilter,
  GitHubCommitSummary,
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
  GitHubTagSummary,
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

/**
 * A queued git push (see `GitHubRepo.push()`). The expected remote ref state is bound at queue
 * time: what the user approves is "move `branch` from `expectedOldSha` to `newSha`", not "move
 * `branch` from wherever it is by then" -- apply enforces `expectedOldSha` via receive-pack's
 * old-sha compare-and-swap, so a branch that moved between approval and apply fails cleanly
 * instead of being clobbered. `expectedOldSha` doubles as the revert target (`ZERO_OID` means
 * the push creates the branch, and revert deletes it).
 */
type PushAction = BaseAction & {
  type: "push";
  branch: string;
  expectedOldSha: string;
  newSha: string;
  force: boolean;
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
  | MergePullRequestAction
  | PushAction;

type StoredActionRecord = {
  action: GitHubAction;
  state: StoredActionState;
  appliedAt?: number;
  rejectedAt?: number;
  revertInfo?: GitHubRevertInfo;
};

/**
 * A `base...head` pull request comparison computed as if the head branch's queued pushes had
 * already landed (see `#simulatedPullComparison`). `pendingCommitIds` are the commits that are
 * not on GitHub yet -- sessions must not advertise them.
 */
type SimulatedPullComparison = {
  revision: GitHubPullRequestRevision;
  files: GitHubPullRequestDiffFile[];
  additions: number;
  deletions: number;
  totalCommits: number;
  /** Oldest-first: GitHub's `compare(base...anchor)` commits, then the pending chain. */
  commitSummaries: GitHubCommitSummary[];
  pendingCommitIds: GitOid[];
};

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const ENTITY_CACHE_TTL_MS = 30 * 1000;
const LIST_CACHE_TTL_MS = 15 * 1000;
// For values that are pure functions of immutable inputs (e.g. the merge base of two commits,
// keyed by both shas): never stale, so only a generation bump (`#clearCaches`) evicts them.
const IMMUTABLE_CACHE_TTL_MS = Infinity;
const VIEWER_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCUSSION_SYNC_OVERLAP_MS = 5 * 1000;
const DISCUSSION_SYNC_BAIL_LIMIT = 500;
const MAX_REPLY_TARGET_HOPS = 50;
// Cap on the queued-but-not-yet-pushed commits walked when simulating a branch's history
// (mirrors GitHub's own 250-commit cap on compare listings).
const MAX_PENDING_CHAIN_COMMITS = 250;

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

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

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

/**
 * The compare response's merge base. GitHub documents `merge_base_commit` as always present; a
 * response without one is treated as malformed rather than approximated -- the base tip
 * (`base_commit`) is *not* the merge base, and reads that need one (tree diffs, merge-base
 * lookups) would silently return wrong data if it stood in.
 */
function mergeBaseOfCompare(compare: GitHubCompareResponse): GitOid {
  const sha = compare.merge_base_commit?.sha;
  if (sha === undefined) {
    throw new Error("GitHub's compare response did not include a merge base.");
  }
  return sha;
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
  /**
   * Re-validates an injected item at the moment `next()` serves it (a page may be drained long
   * after the cursor -- and its injected snapshot -- was built): returns the item to serve,
   * possibly refreshed, or null to drop it. Must not change the item's sort position. Defaults
   * to serving the snapshot as-is.
   */
  #revalidateInjected: (item: T) => T | null;

  /** Rows buffered ahead of what next() has returned; injected ones re-validate when served. */
  #buffer: {item: T, injected: boolean}[] = [];
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
    revalidateInjected?: (item: T) => T | null;
    pageSize: number;
    remotePageSize?: number;
  }) {
    super();
    this.#fetchPage = options.fetchPage;
    this.#overlay = options.overlay;
    this.#filter = options.filter;
    this.#comparator = options.comparator;
    this.#injectedItems = options.injectedItems;
    this.#revalidateInjected = options.revalidateInjected ?? (item => item);
    this.#pageSize = options.pageSize;
    this.#remotePerPage = options.remotePageSize ?? 100;
  }

  async next(): Promise<T[] | null> {
    // Fill the page from the buffer, loading more when it runs dry. Injected rows re-validate
    // at the moment they are *served*, not when they were buffered: #loadMore buffers a whole
    // remote page at once, so with a small page size a row can sit in the buffer across many
    // next() calls -- plenty of time for the state that justified it to change underneath.
    const page: T[] = [];
    while (page.length < this.#pageSize) {
      const entry = this.#buffer.shift();
      if (entry === undefined) {
        if (this.#fullyExhausted()) break;
        await this.#loadMore();
        continue;
      }
      const item = entry.injected ? this.#revalidateInjected(entry.item) : entry.item;
      if (item !== null) page.push(item);
    }

    return page.length === 0 ? null : page;
  }

  #fullyExhausted(): boolean {
    return this.#remoteExhausted && this.#injectedIndex >= this.#injectedItems.length;
  }

  async #loadMore(): Promise<void> {
    if (this.#remoteExhausted) {
      // Remote is done; flush remaining injected items into the buffer.
      this.#flushInjectedBefore(undefined);
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
      this.#flushInjectedBefore(overlaid);
      this.#buffer.push({item: overlaid, injected: false});
    }

    // If remote just became exhausted, flush remaining injected items.
    if (this.#remoteExhausted) {
      this.#flushInjectedBefore(undefined);
    }
  }

  /**
   * Buffer the injected items that sort at or before `limit` (all remaining, when `limit` is
   * undefined). Re-validation happens later, when next() serves them from the buffer.
   */
  #flushInjectedBefore(limit: T | undefined): void {
    while (this.#injectedIndex < this.#injectedItems.length) {
      if (limit !== undefined &&
          this.#comparator(this.#injectedItems[this.#injectedIndex], limit) > 0) {
        return;
      }
      this.#buffer.push({item: this.#injectedItems[this.#injectedIndex++], injected: true});
    }
  }
}

/**
 * RPC wrapper around `CommitAdvertisingCursor` (see git-commits.ts): each page a caller fetches
 * advertises its commit ids to the workspace git cache before it is returned. Owns the `GitCache`
 * stub it is given (a dup of the session's), disposing it with the cursor.
 */
@validateRpc()
class AdvertisingCursor<T> extends RpcTarget implements Cursor<T> {
  #inner: CommitAdvertisingCursor<T>;
  #cache: RpcStub<GitCache>;

  constructor(inner: Cursor<T>, cache: RpcStub<GitCache>, commitIds: (item: T) => GitOid[]) {
    super();
    this.#inner = new CommitAdvertisingCursor(inner, cache, commitIds);
    this.#cache = cache;
  }

  async next(): Promise<T[] | null> {
    return await this.#inner.next();
  }

  [Symbol.dispose](): void {
    this.#cache[Symbol.dispose]();
  }
}

/**
 * Lazily obtains and owns a session's `GitCache` stub (fetched at most once per session, via
 * `ObservationAuthorizer.getGitCache()`), through which the session advertises the commit ids its
 * reads return -- advertisement is workspace-internal pull-routing metadata, not a read, so no
 * observation accompanies it. A plain helper, deliberately not an `RpcTarget`: the cache stub
 * must never be reachable by the session's callers.
 */
class SessionGitCache {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #cache?: Promise<RpcStub<GitCache>>;

  /** `approvalQueue` is only borrowed; the owning session must outlive this helper. */
  constructor(approvalQueue: RpcStub<ApprovalQueue>) {
    this.#approvalQueue = approvalQueue;
  }

  /**
   * The session-owned cache stub itself, for callers that need more than advertising (e.g. the
   * push queue path's ancestry check and pending-commit simulation reads). Borrowed, not
   * transferred: this helper still owns and disposes it.
   */
  stub(): Promise<RpcStub<GitCache>> {
    return this.#get();
  }

  #get(): Promise<RpcStub<GitCache>> {
    this.#cache ??= this.#approvalQueue.getGitCache();
    return this.#cache;
  }

  /**
   * Advertise the given commit ids (deduplicated, in parallel). Values that aren't full commit
   * ids -- e.g. a provisional pull request's empty branch sha -- are skipped.
   */
  async advertise(ids: Iterable<GitOid>): Promise<void> {
    await advertiseCommits(await this.#get(), ids);
  }

  /**
   * Wrap a cursor so that each page it returns advertises its commit ids first. The wrapper holds
   * its own dup of the cache stub, so it keeps working if the session is disposed before the
   * cursor is drained.
   */
  async wrap<T>(cursor: Cursor<T>, commitIds: (item: T) => GitOid[]): Promise<Cursor<T>> {
    const cache = await this.#get();
    return new AdvertisingCursor(cursor, cache.dup(), commitIds);
  }

  dispose(): void {
    void this.#cache?.then(cache => cache[Symbol.dispose]()).catch(() => {});
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
      const handoff = await stub.acceptAuthCode(code, oauthNonce);
      if (!handoff) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return htmlResponse(connectHandoffPageHtml(handoff));
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

  /**
   * Finishes the OAuth code exchange and returns the handoff for the page the browser lands on, or
   * null when the callback's nonce doesn't match.
   */
  async acceptAuthCode(code: string, oauthNonce: string): Promise<ConnectHandoff | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return null;
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

    let handoff: ConnectHandoff;
    if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
      // The reconnect URL is a bearer capability, so the new grant is only staged until the Workshop
      // has confirmed the browser that finished the flow is the owner's (see commitReconnect). Bound
      // gadgets keep reading the current token meanwhile. The stage id ties the Workshop's ticket to
      // this grant, so an overlapping reconnect cannot be committed by it.
      const stageId = stageCredentials(this.ctx.storage.kv, grant, Date.now());
      handoff = await callback.reconnectComplete(stageId);
    } else {
      this.ctx.storage.kv.put("accessToken", grant.accessToken);
      this.ctx.storage.kv.put("scopes", grant.scopes);
      this.ctx.storage.kv.put("expiredNotified", false);
      try {
        const props = { userObjectId: this.ctx.id.toString() };
        handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
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
        return handoff;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return handoff;
  }

  /** Makes the grant staged under `stageId` live; see GatekeeperUser.commitReconnect. */
  async commitReconnect(stageId: string): Promise<void> {
    const grant = commitStagedCredentials<Awaited<ReturnType<typeof exchangeAuthCode>>>(
      this.ctx.storage.kv, Date.now(), stageId);
    if (!grant) throw new Error("No reconnect is awaiting confirmation. Please try again.");
    this.ctx.storage.kv.put("accessToken", grant.accessToken);
    this.ctx.storage.kv.put("scopes", grant.scopes);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.delete("reconnecting");
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

  async commitReconnect(stageId: string): Promise<void> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).commitReconnect(stageId);
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

  /**
   * Commit ids this instance has served from the workspace git cache as part of simulating
   * queued pushes (branch heads *and* the intermediate commits of pending chains). Session
   * advertising callbacks consult it (via `isSimulatedCommitId`) to withhold these ids: they are
   * not on GitHub yet, so advertising one would record a wrong pull-routing hint that outlives a
   * rejection. In-memory only -- entries are always recorded in the same call that returns the
   * ids, so a restart cannot leak an unfiltered id.
   */
  #servedSimulatedCommitIds = new Set<GitOid>();

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
      case "push":
        return false;  // pushes target a branch, never an issue/PR
    }
  }

  #rejectActionsForResource(kind: EntityKind, provisionalId: string): void {
    for (const pending of this.#listPendingActions()) {
      if (this.#actionDependsOnResource(pending, kind, provisionalId)) {
        this.#markActionRejected(pending);
      }
    }
  }

  /**
   * Cascade for a rejected push: reject every queued `createPullRequest` whose head or base
   * branch no longer exists on the remote or as the outcome of the remaining queued pushes,
   * along with everything queued against the doomed pull request. Returns whether anything was
   * cascaded.
   */
  async #rejectPullRequestsForMissingBranches(): Promise<boolean> {
    let cascaded = false;
    for (const pending of this.#listPendingActions()) {
      if (pending.type !== "createPullRequest") continue;
      for (const branch of [pending.options.head, pending.options.base]) {
        const realHead = await this.#withApi(api =>
          api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, branch));
        if (this.#simulateBranchHead(branch, realHead) === null) {
          this.#markActionRejected(pending);
          this.#rejectActionsForResource("pull", pending.provisionalId);
          this.ctx.storage.kv.delete(`provisional:${pending.provisionalId}`);
          cascaded = true;
          break;
        }
      }
    }
    return cascaded;
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
      if (action.type === "createIssue" || action.type === "createPullRequest" ||
          action.type === "push") {
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
    // "repo-v2": the stored shape gained `defaultBranch`, and etag revalidation can keep an
    // old-shaped entry alive past the TTL indefinitely, so a shape change needs a new key.
    const key = this.#cacheKey("repo-v2", this.ctx.props.owner, this.ctx.props.repo);
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
          defaultBranch: result.data.default_branch,
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

  async #getPullRequestDetails(logicalId: string, gitCache?: RpcStub<GitCache>): Promise<GitHubPullRequestDetails> {
    if (logicalId.startsWith("~")) {
      const provisional = this.#getProvisionalResource(logicalId);
      if (!provisional || provisional.kind !== "pull") {
        throw new Error(`No provisional pull request exists with id ${logicalId}`);
      }

      if (provisional.realId) {
        const remote = await this.#getRemotePullRequestDetails(provisional.realId);
        return await this.#overlaySimulatedPullHead(
          this.#overlayIssueLike(remote, "pull", logicalId), gitCache);
      }

      const createAction = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!createAction) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      const provisionalPull = await this.#buildProvisionalPullRequestDetails(createAction, gitCache);
      return this.#overlayIssueLike(provisionalPull, "pull", logicalId, true);
    }

    return await this.#overlaySimulatedPullHead(
      this.#overlayIssueLike(await this.#getRemotePullRequestDetails(logicalId), "pull", logicalId),
      gitCache);
  }

  /**
   * Overlay queued pushes onto an existing pull request's head: when the (same-repo) head branch
   * has pending pushes, the details read as if they had landed -- simulated head sha and
   * recomputed commit/diff stats. `mergeable` is dropped: GitHub's verdict describes the remote
   * head, not the simulated one. Degrades to the remote details if the simulation fails.
   */
  async #overlaySimulatedPullHead(
    details: GitHubPullRequestDetails,
    gitCache?: RpcStub<GitCache>,
  ): Promise<GitHubPullRequestDetails> {
    if (gitCache === undefined || details.head.repo.fullName !== this.#repoFullName()) {
      return details;
    }
    if (this.#pendingPushActions(details.head.ref).length === 0) return details;
    try {
      const simulated =
        await this.#simulatedPullComparison(gitCache, details.base.ref, details.head.ref);
      if (simulated === null) return details;
      return {
        ...details,
        head: { ...details.head, sha: simulated.revision.headSha },
        commits: simulated.totalCommits,
        additions: simulated.additions,
        deletions: simulated.deletions,
        changedFiles: simulated.files.length,
        mergeable: undefined,
      };
    } catch (error) {
      logger.warn("failed to overlay queued pushes onto pull request details", {
        event: "pull.request.simulated.head.overlay.failed", error,
      });
      return details;
    }
  }

  /**
   * The synchronous sibling of `#overlaySimulatedPullHead` for pull request *summaries* (which
   * carry no diff stats): a same-repo head branch with queued pushes reads at its simulated
   * head. The simulated sha is always a queued push's newSha, so `isSimulatedCommitId` already
   * withholds it from session advertising.
   */
  #overlayPullSummaryHead<T extends GitHubPullRequestSummary>(item: T): T {
    if (item.head.repo.fullName !== this.#repoFullName()) return item;
    if (this.#pendingPushActions(item.head.ref).length === 0) return item;
    const simulated = this.#simulateBranchHead(item.head.ref, item.head.sha);
    if (simulated === null || simulated === item.head.sha) return item;
    return { ...item, head: { ...item.head, sha: simulated } };
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

  async #buildProvisionalPullRequestDetails(
    action: CreatePullRequestAction,
    gitCache?: RpcStub<GitCache>,
  ): Promise<GitHubPullRequestDetails> {
    const viewer = await this.#getViewerActor();
    let baseSha = "";
    let headSha = "";
    let commits = 0;
    let additions = 0;
    let deletions = 0;
    let changedFiles = 0;

    try {
      // The head branch may itself be provisional -- moved, or outright created, by queued
      // pushes. The simulated comparison reads it as if those pushes had landed; only when no
      // overlay applies is GitHub's live compare the truth.
      const simulated =
        await this.#simulatedPullComparison(gitCache, action.options.base, action.options.head);
      if (simulated !== null) {
        baseSha = simulated.revision.baseSha;
        headSha = simulated.revision.headSha;
        commits = simulated.totalCommits;
        additions = simulated.additions;
        deletions = simulated.deletions;
        changedFiles = simulated.files.length;
      } else {
        const comparison = await this.#withApi(api => api.compareBranches(
          this.ctx.props.owner,
          this.ctx.props.repo,
          action.options.base,
          action.options.head,
        ));
        this.#recordCompareMergeBase(comparison);
        baseSha = comparison.base_commit.sha;
        headSha = comparison.commits?.at(-1)?.sha ?? comparison.base_commit.sha;
        commits = comparison.total_commits;
        additions = (comparison.files ?? []).reduce((sum, file) => sum + file.additions, 0);
        deletions = (comparison.files ?? []).reduce((sum, file) => sum + file.deletions, 0);
        changedFiles = comparison.files?.length ?? 0;
      }
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

  async #listPullSummaries(
    filter: GitHubPullRequestFilter | undefined,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    const compare = pullComparator(filter?.sort, filter?.direction);
    const touched = await this.#buildTouchedPullSummaries(item => pullMatchesFilter(item, filter), compare);

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreatePullRequestAction => action.type === "createPullRequest")
      .map(action => this.#buildProvisionalPullRequestDetails(action, gitCache).then(pull => this.#overlayIssueLike(pull, "pull", action.provisionalId, true)))))
      .filter(item => pullMatchesFilter(item, filter))
      .toSorted(compare);
    const injectedItems = [...touched.items.map(item => this.#overlayPullSummaryHead(item)), ...provisionals]
      .toSorted(compare);

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
      overlay: item => this.#overlayPullSummaryHead(this.#overlayIssueLike(item, "pull", item.id)),
      filter: item => pullMatchesFilter(item, filter),
      comparator: compare,
      injectedItems,
      pageSize,
    });
  }

  async #searchPullSummaries(
    query: GitHubPullRequestSearch,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    const compare = pullComparator("updated", "desc");

    const provisionals = (await Promise.all(this.#listPendingActions()
      .filter((action): action is CreatePullRequestAction => action.type === "createPullRequest")
      .map(action => this.#buildProvisionalPullRequestDetails(action, gitCache).then(pull => this.#overlayIssueLike(pull, "pull", action.provisionalId, true)))))
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
      overlay: item => this.#overlayPullSummaryHead(this.#overlayIssueLike(item, "pull", item.id)),
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

  async #getDiff(
    logicalId: string,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<{ revision: GitHubPullRequestRevision; files: Cursor<GitHubPullRequestDiffFile> }> {
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      // The head branch may itself be provisional (moved or created by queued pushes); read the
      // comparison as if those pushes had landed. GitHub's live compare would 404 on a branch
      // that does not exist yet, or silently describe its stale head.
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, action.options.base, action.options.head);
      if (simulated !== null) {
        return { revision: simulated.revision, files: new ArrayCursor(simulated.files, pageSize) };
      }

      const cached = await this.#compareForProvisionalPull(
        this.#cacheKey("compare-provisional-v2", logicalId), action);
      return { revision: cached.revision, files: new ArrayCursor(cached.files, pageSize) };
    }

    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    const details = await this.#getRemotePullRequestDetails(realId);
    // An existing pull request whose head branch has queued pushes reads its diff at the
    // simulated head, like every other read of that branch.
    if (gitCache !== undefined && details.head.repo.fullName === this.#repoFullName() &&
        this.#pendingPushActions(details.head.ref).length > 0) {
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, details.base.ref, details.head.ref);
      if (simulated !== null) {
        return { revision: simulated.revision, files: new ArrayCursor(simulated.files, pageSize) };
      }
    }
    // "diff-v2": the stored revision gained `mergeBaseSha`, and old-shaped entries under the
    // previous key may outlive the TTL via etag revalidation.
    const cacheKey = this.#cacheKey("diff-v2", realId, details.base.sha || "pending", details.head.sha || "pending");
    const cached = this.#loadCached<{ revision: GitHubPullRequestRevision; files: GitHubPullRequestDiffFile[] }>(cacheKey, ENTITY_CACHE_TTL_MS);
    if (cached) {
      return { revision: cached.revision, files: new ArrayCursor(cached.files, pageSize) };
    }

    const revision: GitHubPullRequestRevision = {
      baseSha: details.base.sha,
      headSha: details.head.sha,
      // The PR-files pages below diff against the merge base but never name it; one compare
      // (cached immutably per sha pair) recovers it.
      mergeBaseSha: await this.#mergeBaseOrWarn(details.base.sha, details.head.sha),
    };
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

  /**
   * `Gatekeeper.gitPull()`: fetch the requested objects from this repo over git smart-HTTP
   * (protocol v2) and deposit them in the workspace git cache. The gatekeeper contributes only
   * protocol framing -- git-transport.ts composes the fetch command from the hints and strips
   * the response down to the raw pack body, which streams into `cache.consumePack()` for
   * overseer-side decoding, hash verification, and storage -- and retains nothing locally.
   *
   * No observation is recorded: a pull is overseer-initiated population of the workspace cache
   * with objects whose commit ids were already returned (and advertised) by observed session
   * reads, not a new agent-visible read; observer access to the git data rides the same
   * repo-level ACL as everything else here (strategy B).
   */
  async gitPull(oids: GitOid[], cache: RpcStub<GitCache>, hints: GitPullHints): Promise<void> {
    await this.#withApi(api => pullGitObjectsIntoCache(
      body => api.fetchGitUploadPack(this.ctx.props.owner, this.ctx.props.repo, body),
      oids, hints, cache));
  }

  async applyAction(actionId: number, cache: RpcStub<GitCache>): Promise<void> {
    const record = this.#requireActionRecord(actionId);
    if (record.state !== "pending" && record.state !== "staged") {
      // A push this gatekeeper already recorded as applied reports idempotent success, not an
      // error: the overseer persists its own completion record only after this method returns,
      // so a crash in that window re-delivers the apply -- and by then the branch may have
      // legitimately moved on from newSha, so only this durable record (never a desired-state
      // re-check) can answer the retry. Throwing here would strand the action as forever
      // un-appliable. Other action types keep the guard: their retried external mutations are a
      // pre-existing gap the applyAction() contract tracks as future work.
      if (record.state === "approved" && record.action.type === "push") return;
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
        let response;
        try {
          response = await this.#withApi(api => api.createPullRequest(action.owner, action.repo, {
            title: action.options.title,
            body: action.options.bodyMarkdown ? this.#rewriteKnownReferences(action.options.bodyMarkdown, true) : undefined,
            head: action.options.head,
            base: action.options.base,
            draft: action.options.draft,
          }));
        } catch (error) {
          // The typical cause of a validation failure here is ordering: the pull request was
          // queued against a branch whose push is still awaiting approval, and this action was
          // approved first (GitHub then sees a missing branch, or one with no commits against
          // the base). The action stays pending; applying it again after the push works.
          if (error instanceof GitHubApiError && error.status === 422 &&
              this.#pendingPushActions(action.options.head).length > 0) {
            throw new Error(
              `Cannot create this pull request yet: branch "${action.options.head}" has a queued ` +
              `push that has not been applied. Approve the push to "${action.options.head}" ` +
              `first, then approve this pull request.`, { cause: error });
          }
          throw error;
        }
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
      case "push": {
        // No gatekeeper-side object walk: the overseer composes the pack from the action's
        // pending-push marks (`cache.buildPack()` on the action-scoped stub), and this side
        // contributes only send-pack framing plus the ref-update command. The command's old-sha
        // is the queue-time `expectedOldSha` -- receive-pack's compare-and-swap applies to every
        // update, force or not (fast-forward policy was already enforced at queue time), so a
        // branch that moved between approval and apply fails cleanly instead of being clobbered.
        try {
          const pack = await cache.buildPack();
          await this.#withApi(api => pushGitRefUpdate(
            body => api.fetchGitReceivePack(action.owner, action.repo, body),
            { branch: action.branch, oldSha: action.expectedOldSha, newSha: action.newSha },
            pack));
        } catch (error) {
          if (!(error instanceof GitRefUpdateRejectedError)) throw error;
          // Desired-state semantics: apply succeeds iff the branch ends up at newSha -- by our
          // CAS'd push, or by finding it already there (a retried apply whose first attempt
          // landed but crashed before this record was persisted, or a third party's
          // byte-identical push -- indistinguishable, and the approved end state holds either
          // way).
          const head = await this.#withApi(api =>
            api.getBranchHead(action.owner, action.repo, action.branch));
          if (head !== action.newSha) {
            throw new Error(action.expectedOldSha === ZERO_OID
              ? `The push cannot be applied: a branch named "${action.branch}" was created ` +
                `after this push was queued (the push would have created it). Re-observe the ` +
                `branch and queue a fresh push against its current head.`
              : `The push cannot be applied: branch "${action.branch}" has moved from ` +
                `${action.expectedOldSha}, the head it was approved against. Re-observe the ` +
                `branch and queue a fresh push against its current head.`,
              { cause: error });
          }
        }
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

    if (action.type === "push") {
      // A queued pull request may depend on this push for its head (or base) branch to exist at
      // all. With the push rejected, such a pull request can never be created -- cascade-reject
      // it (and, transitively, everything queued against it), mirroring how rejecting a
      // provisional create rejects its dependents. A pull request whose branches still exist --
      // really, or through the remaining queued pushes -- is left queued: a later push can still
      // deliver the branch content.
      const cascaded = await this.#rejectPullRequestsForMissingBranches();
      this.#clearCaches();
      return cascaded ? { restart: true } : undefined;
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
      case "push": {
        // Ref rollback: move the branch back to the head the user approved pushing it from
        // (delete it, if the push created it). The command's old-sha is the pushed commit, so
        // work that landed on the branch after the push is never stomped -- the rollback then
        // fails cleanly instead. The pushed objects stay on the remote (they merely go
        // dangling), which is also why the rollback needs no pack contents: an empty pack
        // accompanies the update, and a deletion sends none (the protocol forbids it).
        const deleting = action.expectedOldSha === ZERO_OID;
        try {
          await this.#withApi(async api => pushGitRefUpdate(
            body => api.fetchGitReceivePack(action.owner, action.repo, body),
            {
              branch: action.branch,
              oldSha: action.newSha,
              newSha: deleting ? ZERO_OID : action.expectedOldSha,
            },
            deleting ? null : bytesToStream(await emptyPackBytes())));
        } catch (error) {
          if (error instanceof GitRefUpdateRejectedError) {
            return {
              message: `Branch "${action.branch}" is no longer at the pushed commit ` +
                `${action.newSha}, so it cannot be rolled back automatically. Reset the branch ` +
                `manually if needed.`,
              canRetry: false,
            };
          }
          throw error;
        }
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

  async openPullRequest(id: string, gitCache?: RpcStub<GitCache>): Promise<GitHubPullRequestDetails> {
    return await this.#getPullRequestDetails(id, gitCache);
  }

  async issueDiscussion(kind: EntityKind, id: string, pageSize: number): Promise<Cursor<GitHubDiscussionEntry>> {
    return this.#getDiscussion(kind, id, pageSize);
  }

  async pullDiff(id: string, pageSize: number, gitCache?: RpcStub<GitCache>): Promise<{ revision: GitHubPullRequestRevision; files: Cursor<GitHubPullRequestDiffFile> }> {
    return this.#getDiff(id, pageSize, gitCache);
  }

  /**
   * The merge base of a pull request's head and base, resolved like `pullDiff`'s revision (same
   * provisional and queued-push simulation paths) but without fetching any diff. Always a commit
   * GitHub itself knows -- even a simulated head's merge base comes from a live compare against
   * the pending chain's anchor -- so sessions may advertise it.
   */
  async pullMergeBase(id: string, gitCache?: RpcStub<GitCache>): Promise<GitOid> {
    if (id.startsWith("~") && !this.#resolveProvisionalId(id)) {
      const action = this.#findCreateAction(id, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${id} is no longer available.`);
      }
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, action.options.base, action.options.head);
      if (simulated?.revision.mergeBaseSha !== undefined) return simulated.revision.mergeBaseSha;
      const cached = await this.#compareForProvisionalPull(
        this.#cacheKey("compare-provisional-v2", id), action);
      if (cached.revision.mergeBaseSha === undefined) {
        throw new Error(`GitHub did not report a merge base for pull request ${id}.`);
      }
      return cached.revision.mergeBaseSha;
    }

    const realId = id.startsWith("~") ? this.#resolveProvisionalId(id)! : id;
    const details = await this.#getRemotePullRequestDetails(realId);
    // A head branch with queued pushes reads at its simulated head, like every other read of
    // that branch; its comparison already knows the merge base it diffs from.
    if (gitCache !== undefined && details.head.repo.fullName === this.#repoFullName() &&
        this.#pendingPushActions(details.head.ref).length > 0) {
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, details.base.ref, details.head.ref);
      if (simulated?.revision.mergeBaseSha !== undefined) return simulated.revision.mergeBaseSha;
    }
    return await this.#getMergeBaseCached(details.base.sha, details.head.sha);
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

  async listPullRequests(
    filter: GitHubPullRequestFilter | undefined,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    return this.#listPullSummaries(filter, pageSize, gitCache);
  }

  async searchPullRequests(
    query: GitHubPullRequestSearch,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubPullRequestSummary>> {
    return this.#searchPullSummaries(query, pageSize, gitCache);
  }

  /** The queued pushes, oldest first (optionally only those targeting `branch`). */
  #pendingPushActions(branch?: string): PushAction[] {
    return this.#listPendingActions().filter((action): action is PushAction =>
      action.type === "push" && (branch === undefined || action.branch === branch));
  }

  /**
   * Whether `commitId` is the head of a push queued on this gatekeeper -- a commit simulation
   * may hand back that is not on GitHub yet. Session read paths consult this to withhold
   * advertisement of such commits (see `getCommit` for why a cache-served result must not be
   * advertised). Deliberately synchronous, so per-page cursor advertising can check it live as
   * pages are drained; sessions hold this object directly and never call it over RPC.
   */
  isCommitPendingPush(commitId: GitOid): boolean {
    return this.#pendingPushActions().some(action => action.newSha === commitId);
  }

  /**
   * Whether `commitId` is a commit simulation may have handed back that is not on GitHub yet: a
   * queued push's head, or any commit this instance served from the workspace git cache while
   * simulating one (pending chains include the intermediate commits between stacked pushes,
   * which `isCommitPendingPush` alone would miss). Session advertising callbacks consult this,
   * synchronously like `isCommitPendingPush`, to withhold such ids from `advertiseCommit()`.
   */
  isSimulatedCommitId(commitId: GitOid): boolean {
    return this.#servedSimulatedCommitIds.has(commitId) || this.isCommitPendingPush(commitId);
  }

  #repoFullName(): string {
    return `${this.ctx.props.owner}/${this.ctx.props.repo}`;
  }

  /**
   * A branch's current remote head (null if the branch does not exist), cached briefly.
   * Simulation reads use this; the push queue path deliberately keeps using the uncached
   * `getBranchHead`, since a push's expected old head must reflect the remote's live state.
   */
  async #getBranchHeadCached(branch: string): Promise<string | null> {
    const key = this.#cacheKey("branch-head", stableKey(branch));
    const cached = this.#loadCached<{ head: string | null }>(key, ENTITY_CACHE_TTL_MS);
    if (cached !== undefined) return cached.head;
    const head = await this.#withApi(api =>
      api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, branch));
    this.#storeCached(key, { head });
    return head;
  }

  /**
   * Record a compare response's merge base in the pair-keyed immutable cache: the merge base of
   * two fixed commits never changes, so any compare that names one -- whatever read wanted the
   * compare -- makes later merge-base lookups of that pair free. `headSha` is the compare's head
   * commit when the caller knows it by sha; a compare made by ref otherwise names its own head
   * only as the last listed commit (absent when the compared range is empty or truncated by
   * paging, in which case nothing is recorded).
   */
  #recordCompareMergeBase(compare: GitHubCompareResponse, headSha?: string): void {
    const mergeBase = compare.merge_base_commit?.sha;
    const head = headSha ?? compare.commits?.at(-1)?.sha;
    if (mergeBase === undefined || head === undefined || !isCommitOid(head)) return;
    this.#storeCached(this.#cacheKey("merge-base", compare.base_commit.sha, head), mergeBase);
  }

  /**
   * The merge base of two commits: answered from the pair-keyed cache when a previous compare
   * already named it, else by one metadata-only compare call -- page 2 of the paged form, since
   * GitHub puts the changed-files array (up to 300 entries, patches included) only on a
   * compare's first page, while every page carries the metadata this read wants.
   */
  async #getMergeBaseCached(baseSha: string, headSha: string): Promise<GitOid> {
    const key = this.#cacheKey("merge-base", baseSha, headSha);
    const cached = this.#loadCached<GitOid>(key, IMMUTABLE_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    const compare = await this.#withApi(api =>
      api.compareBranches(this.ctx.props.owner, this.ctx.props.repo, baseSha, headSha,
        { perPage: 1, page: 2 }));
    const mergeBase = mergeBaseOfCompare(compare);
    this.#storeCached(key, mergeBase);
    return mergeBase;
  }

  /**
   * `#getMergeBaseCached`, degrading a failure (or a sha that is not a full commit id, e.g. a
   * provisional pull request's empty one) to undefined with a warning: the diff read this
   * decorates works without a merge base -- for instance a head commit from a deleted fork that
   * GitHub can no longer compare -- so it must not fail outright.
   */
  async #mergeBaseOrWarn(baseSha: string, headSha: string): Promise<GitOid | undefined> {
    if (!isCommitOid(baseSha) || !isCommitOid(headSha)) return undefined;
    try {
      return await this.#getMergeBaseCached(baseSha, headSha);
    } catch (error) {
      logger.warn("failed to determine a pull request's merge base", {
        event: "pull.request.merge.base.failed", error,
      });
      return undefined;
    }
  }

  /** Whether GitHub knows this commit (the anchor test for pending-chain walks). */
  async #isCommitOnGitHub(oid: GitOid): Promise<boolean> {
    try {
      await this.#getRemoteCommitDetails(oid);
      return true;
    } catch (error) {
      // GitHub answers an unknown branch/tag name with 404 but an unknown full commit id with
      // 422 ("No commit found for SHA: ..."), and this probe is always a full id.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Walk a simulated branch head down to its **anchor** -- the first commit GitHub already knows
   * -- reading the not-yet-pushed commits from the workspace git cache (which serves this
   * gatekeeper's queued-push closure, pulling objects through on demand). Returns the pending
   * commits newest-first plus the anchor. Multi-parent (merge) commits are walked through their
   * first parent; a chain that leaves the cache or bottoms out with no GitHub-known ancestor
   * throws, and callers degrade.
   *
   * Every commit id read here is recorded in `#servedSimulatedCommitIds`, so sessions withhold
   * it from advertising.
   */
  async #collectPendingChain(gitCache: RpcStub<GitCache>, head: GitOid): Promise<{
    commits: { summary: GitHubCommitSummary; tree: GitOid }[];
    anchor: GitOid;
  }> {
    // A push's expectedOldSha is usually known to GitHub without a probe: it was read from the
    // remote at queue time. But not always -- stacked pushes bind each expectedOldSha to the
    // *previous queued push's* newSha (a pending commit), so anything that is itself a queued
    // push's newSha is excluded here, and the walk continues through it to the real anchor
    // (ZERO_OID -- branch creation -- likewise).
    const pendingNewShas = new Set(this.#pendingPushActions().map(action => action.newSha));
    const knownShas = new Set(this.#pendingPushActions()
      .map(action => action.expectedOldSha)
      .filter(sha => sha !== ZERO_OID && !pendingNewShas.has(sha)));

    const commits: { summary: GitHubCommitSummary; tree: GitOid }[] = [];
    let current = head;
    while (commits.length <= MAX_PENDING_CHAIN_COMMITS) {
      if (knownShas.has(current) || await this.#isCommitOnGitHub(current)) {
        return { commits, anchor: current };
      }
      const object = await gitCache.get(current);
      if (object === null || object.type !== "commit") {
        throw new Error(`Commit ${current} is not available from the workspace git cache.`);
      }
      const parsed = parseGitCommitPayload(object.content, current);
      this.#servedSimulatedCommitIds.add(current);
      commits.push({
        summary: commitDetailsFromGitObject(
          current, object.content, canonicalRepoUrl(this.ctx.props.owner, this.ctx.props.repo)),
        tree: parsed.tree,
      });
      if (parsed.parents.length === 0) {
        throw new Error(`Commit ${current} has no ancestor known to GitHub.`);
      }
      current = parsed.parents[0];
    }
    throw new Error(`More than ${MAX_PENDING_CHAIN_COMMITS} commits are queued for push.`);
  }

  /** The tree oid of a commit, from cached bytes when available, else GitHub's commit API. */
  async #treeOidOfCommit(gitCache: RpcStub<GitCache>, sha: GitOid): Promise<GitOid> {
    const object = await gitCache.get(sha);
    if (object !== null && object.type === "commit") {
      return parseGitCommitPayload(object.content, sha).tree;
    }
    const key = this.#cacheKey("commit-tree", sha);
    const cached = this.#loadCached<GitOid>(key, ENTITY_CACHE_TTL_MS);
    if (cached !== undefined) return cached;
    const result = await this.#withApi(api =>
      api.getCommitConditional(this.ctx.props.owner, this.ctx.props.repo, sha));
    const tree = result.status === 200 ? result.data.commit.tree?.sha : undefined;
    if (tree === undefined) {
      throw new Error(`Could not resolve the tree of commit ${sha}.`);
    }
    this.#storeCached(key, tree);
    return tree;
  }

  /**
   * Object source for the simulated-diff tree walk: the workspace git cache first (the pending
   * side always resolves there -- the queued-push closure pulls through on demand), falling back
   * to GitHub's git-data API for on-remote objects the cache does not hold.
   */
  #treeDiffSource(gitCache: RpcStub<GitCache>): TreeDiffSource {
    const { owner, repo } = this.ctx.props;
    return {
      getTree: async oid => {
        const object = await gitCache.get(oid);
        if (object !== null && object.type === "tree") {
          return parseGitTreePayload(object.content, oid);
        }
        const remote = await this.#withApi(api => api.getGitTree(owner, repo, oid));
        if (remote === null || remote.truncated) return null;
        return remote.tree.map(entry => ({ mode: entry.mode, name: entry.path, oid: entry.sha }));
      },
      getBlob: async oid => {
        const object = await gitCache.get(oid);
        if (object !== null && object.type === "blob") return object.content;
        const remote = await this.#withApi(api =>
          api.getGitBlob(owner, repo, oid, MAX_DIFF_BLOB_BYTES));
        return remote === null || remote === "oversized" ? "unavailable" : remote;
      },
    };
  }

  /**
   * The simulated `base...head` comparison for a pull request whose head branch has queued
   * pushes, computed as if those pushes had already landed: the head is the simulated branch
   * head, the commit list splices GitHub's `compare(base...anchor)` with the pending chain, and
   * the file diff is a local tree diff from the merge base to the simulated head (GitHub cannot
   * compute it -- the pending commits are not on the remote). Returns null when no overlay
   * applies (no cache, no queued pushes, or the remote has invalidated their expectations), so
   * callers fall through to the ordinary remote reads.
   *
   * Results are cached per (base, simulated head); every write action bumps the cache
   * generation, so a queued/applied/rejected push invalidates them.
   *
   * Known gap: a queued push to the *base* branch is not overlaid here -- the comparison uses
   * the base branch's remote state (the merge base against a not-yet-pushed base commit is
   * unknowable to GitHub).
   */
  async #simulatedPullComparison(
    gitCache: RpcStub<GitCache> | undefined,
    baseRef: string,
    headBranch: string,
  ): Promise<SimulatedPullComparison | null> {
    if (gitCache === undefined) return null;
    if (this.#pendingPushActions(headBranch).length === 0) return null;
    const realHead = await this.#getBranchHeadCached(headBranch);
    const simulatedHead = this.#simulateBranchHead(headBranch, realHead);
    if (simulatedHead === null || simulatedHead === realHead) return null;

    const cacheKey = this.#cacheKey("pull-simulated", stableKey(baseRef), simulatedHead);
    const cached = this.#loadCached<SimulatedPullComparison>(cacheKey, ENTITY_CACHE_TTL_MS);
    if (cached !== undefined) {
      // The served-id set is in-memory; re-record the cached result's pending ids so this
      // instance's advertising filter covers them too.
      for (const id of cached.pendingCommitIds) this.#servedSimulatedCommitIds.add(id);
      return cached;
    }

    const chain = await this.#collectPendingChain(gitCache, simulatedHead);
    const compare = await this.#withApi(api =>
      api.compareBranches(this.ctx.props.owner, this.ctx.props.repo, baseRef, chain.anchor));
    this.#recordCompareMergeBase(compare, chain.anchor);
    // Malformed (merge-base-less) responses throw here, degrading via
    // #simulatedPullComparisonOrWarn: the tree diff below would be wrong against any other base.
    const mergeBase = mergeBaseOfCompare(compare);

    const newTree = chain.commits.length > 0
      ? chain.commits[0].tree
      : await this.#treeOidOfCommit(gitCache, simulatedHead);
    const files = await diffGitTrees(
      this.#treeDiffSource(gitCache), await this.#treeOidOfCommit(gitCache, mergeBase), newTree);

    const result: SimulatedPullComparison = {
      // The pending chain descends from the anchor without touching the base branch, so the
      // diff's merge base is the compare's (base, anchor) one.
      revision: { baseSha: compare.base_commit.sha, headSha: simulatedHead, mergeBaseSha: mergeBase },
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      totalCommits: compare.total_commits + chain.commits.length,
      // Oldest-first, like GitHub's compare and PR commit listings.
      commitSummaries: [
        ...(compare.commits ?? []).map(normalizeCommitSummary),
        ...chain.commits.map(commit => commit.summary).toReversed(),
      ],
      pendingCommitIds: chain.commits.map(commit => commit.summary.id),
    };
    this.#storeCached(cacheKey, result);
    return result;
  }

  /**
   * `#simulatedPullComparison`, degrading a simulation failure (e.g. a chain commit no longer
   * pullable) to null with a warning, so read paths fall back to their remote reads rather than
   * failing outright.
   */
  async #simulatedPullComparisonOrWarn(
    gitCache: RpcStub<GitCache> | undefined,
    baseRef: string,
    headBranch: string,
  ): Promise<SimulatedPullComparison | null> {
    try {
      return await this.#simulatedPullComparison(gitCache, baseRef, headBranch);
    } catch (error) {
      logger.warn("failed to simulate a pull request comparison over queued pushes", {
        event: "pull.request.simulated.comparison.failed", error,
      });
      return null;
    }
  }

  /**
   * GitHub's live `base...head` compare for a provisional pull request with no queued-push
   * overlay, cached and normalized. A 404 -- either branch missing from the remote -- becomes an
   * agent-actionable error instead of a raw API failure. Callers key this under
   * `compare-provisional-v2`: the stored revision gained `mergeBaseSha`, and etag revalidation
   * can keep an old-shaped entry alive past the TTL.
   */
  async #compareForProvisionalPull(cacheKey: string, action: CreatePullRequestAction): Promise<{
    revision: GitHubPullRequestRevision;
    files: GitHubPullRequestDiffFile[];
    commits: GitHubCommitSummary[];
  }> {
    try {
      return await this.#loadCachedWithEtag(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
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

        this.#recordCompareMergeBase(comparison.data);
        const revision = {
          baseSha: comparison.data.base_commit.sha,
          headSha: comparison.data.commits?.at(-1)?.sha ?? comparison.data.base_commit.sha,
          mergeBaseSha: comparison.data.merge_base_commit?.sha,
        };
        return {
          status: 200,
          headers: comparison.headers,
          data: {
            revision,
            files: (comparison.data.files ?? []).map(file => this.#normalizeDiffFile(file)),
            commits: (comparison.data.commits ?? []).map(normalizeCommitSummary),
          },
        };
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new Error(
          `Cannot compare branches "${action.options.base}" and "${action.options.head}" for ` +
          `pull request ${action.provisionalId}: at least one of them does not exist on GitHub. ` +
          `Push the missing branch first.`, { cause: error });
      }
      throw error;
    }
  }

  /**
   * The head a branch reads at once its queued pushes are treated as applied: starting from the
   * real head (`null` = the branch does not exist), each queued push whose bound `expectedOldSha`
   * matches advances it to that push's `newSha` -- exactly the transition apply will enforce, so
   * stacked pushes compose and a push whose expectation the remote has since invalidated simply
   * stops overlaying. This is both the simulation read (`listBranches`/`getCommit`) and what the
   * queue path binds the *next* push's `expectedOldSha` to.
   */
  #simulateBranchHead(branch: string, realHead: string | null): string | null {
    let head = realHead;
    // Chain-follow to a fixpoint rather than trusting list order: each queued push binds its
    // expectation to the previous one's newSha, so consuming "the action expecting the current
    // head" until none matches applies a well-formed chain regardless of tie-broken ordering.
    const remaining = this.#pendingPushActions(branch);
    for (let index = 0; index !== -1;) {
      index = remaining.findIndex(action =>
        head === (action.expectedOldSha === ZERO_OID ? null : action.expectedOldSha));
      if (index !== -1) {
        head = remaining[index].newSha;
        remaining.splice(index, 1);
      }
    }
    return head;
  }

  // Reads a commit queued for push (or already proven on this remote) from the workspace git
  // cache and synthesizes the details shape from its exact bytes; null if the cache's scoped
  // view doesn't serve it as a commit.
  async #tryReadCachedCommitDetails(
    gitCache: RpcStub<GitCache>, oid: string,
  ): Promise<GitHubCommitDetails | null> {
    const object = await gitCache.get(oid);
    if (object === null || object.type !== "commit") return null;
    return commitDetailsFromGitObject(
      oid, object.content, canonicalRepoUrl(this.ctx.props.owner, this.ctx.props.repo));
  }

  async listBranches(filter: GitHubBranchFilter | undefined, pageSize: number): Promise<Cursor<GitHubBranchSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;

    // Simulation: a branch a queued push *creates* is injected (protected: false, like any new
    // branch) -- but only while the remote still lacks the name, checked against the live
    // branch here, mirroring how a head overlay stops applying once the remote invalidates its
    // expectation (and the same condition apply's zero-id CAS will enforce). If the branch has
    // appeared remotely in the interim, nothing is injected and the real row is listed (with
    // the ordinary head overlay), so reads never hide a branch that genuinely exists. The
    // name filter below only closes the race between this check and the page fetch.
    const injectedNames = new Set<string>();
    const injectedItems: GitHubBranchSummary[] = [];
    const creationsChecked = new Set<string>();
    for (const action of this.#pendingPushActions()) {
      if (action.expectedOldSha !== ZERO_OID || creationsChecked.has(action.branch)) continue;
      creationsChecked.add(action.branch);
      const realHead = await this.#withApi(api =>
        api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, action.branch));
      if (realHead !== null) continue;
      const head = this.#simulateBranchHead(action.branch, null);
      if (head === null) continue;
      injectedNames.add(action.branch);
      if (filter?.protected !== true) {
        // Served-simulated recording (not just isCommitPendingPush coverage): the page carrying
        // this row may be drained after the push is rejected, and the advertising callback must
        // still withhold a head that never reached the remote.
        this.#servedSimulatedCommitIds.add(head);
        injectedItems.push({ name: action.branch, headCommit: head, protected: false });
      }
    }

    return new StreamingCursor<GitHubBranchSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-branches", stableKey(filter ?? {}), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubBranchSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listBranchesConditional(owner, repo, {
            protected: filter?.protected,
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeBranchSummary),
          };
        });
      },
      // A branch a queued push moves reads at the pushed head (see #simulateBranchHead). The
      // simulated head is recorded as served so the advertising callback withholds it even if
      // the push is rejected between this overlay and the page's advertisement.
      overlay: item => {
        const head = this.#simulateBranchHead(item.name, item.headCommit) ?? item.headCommit;
        if (head === item.headCommit) return item;
        this.#servedSimulatedCommitIds.add(head);
        return { ...item, headCommit: head };
      },
      filter: item => !injectedNames.has(item.name),
      comparator: () => 0,
      injectedItems,
      // Injected rows are snapshots from cursor-build time, but a queued creation can be
      // rejected (or superseded) before the page carrying its row is drained -- re-simulate from
      // the live queue at serve time, dropping the row when no queued creation remains, so a
      // rejected push's branch stops being listed. (The eager loop above already verified the
      // branch is absent remotely; a branch appearing mid-drain is the documented filter race.)
      revalidateInjected: item => {
        const head = this.#simulateBranchHead(item.name, null);
        if (head === null) return null;
        this.#servedSimulatedCommitIds.add(head);
        return head === item.headCommit ? item : { ...item, headCommit: head };
      },
      pageSize,
    });
  }

  async listTags(pageSize: number): Promise<Cursor<GitHubTagSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    return new StreamingCursor<GitHubTagSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-tags", `p${page}`);
        return await this.#loadCachedWithEtag<GitHubTagSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listTagsConditional(owner, repo, {
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeTagSummary),
          };
        });
      },
      overlay: item => item,
      filter: () => true,
      comparator: () => 0,
      injectedItems: [],
      pageSize,
    });
  }

  /**
   * Look up a commit for the session. `fromCache` reports whether the details were served from
   * the workspace git cache rather than from GitHub; the session must not advertise a
   * cache-served result -- either the commit was populated from this remote in the first place
   * (its provenance is already recorded, so advertising again is a no-op) or it is part of a
   * pending push (not on the remote yet, and an advertisement would outlive a rejection as a
   * permanently wrong pull-routing hint that also makes future push marking walks skip the
   * object as remote-known).
   */
  async getCommit(refOrDefault: string | undefined, gitCache?: RpcStub<GitCache>)
      : Promise<{ details: GitHubCommitDetails, fromCache: boolean }> {
    // An omitted ref means the default branch, resolved here rather than passed through to
    // GitHub so a queued push to the default branch still simulates.
    const ref = refOrDefault ?? (await this.#getRepoMetadata()).defaultBranch;
    // Simulation: a branch name with queued pushes resolves to its simulated head, read from the
    // workspace git cache (a queued commit reads exactly as it will once pushed).
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      let realHead: string | null = null;
      try {
        realHead = (await this.#getRemoteCommitDetails(ref)).id;
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      }
      const simulated = this.#simulateBranchHead(ref, realHead);
      if (simulated !== null && simulated !== realHead) {
        const details = await this.#tryReadCachedCommitDetails(gitCache, simulated);
        if (details !== null) return { details, fromCache: true };
      }
      if (realHead === null) {
        throw new Error(`No commit found for ref "${ref}".`);
      }
      // The overlay was a no-op (e.g. the remote invalidated the queued push's expectation);
      // fall through to the real read.
    }

    try {
      return { details: await this.#getRemoteCommitDetails(ref), fromCache: false };
    } catch (error) {
      // A full commit id GitHub doesn't know yet may be queued for push; serve it from the
      // workspace git cache so the caller sees the world as if the push had landed. GitHub
      // reports an unknown full commit id as 422 ("No commit found for SHA: ..."), not 404 --
      // but accept both, since the guard already requires a full id.
      if (gitCache !== undefined && isCommitOid(ref) &&
          error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
        const details = await this.#tryReadCachedCommitDetails(gitCache, ref);
        if (details !== null) return { details, fromCache: true };
      }
      throw error;
    }
  }

  async #getRemoteCommitDetails(ref: string): Promise<GitHubCommitDetails> {
    // Commits are immutable, but `ref` may be a branch or tag name, so the short TTL still applies.
    const cacheKey = this.#cacheKey("commit", stableKey(ref));
    return await this.#loadCachedWithEtag<GitHubCommitDetails>(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getCommitConditional(this.ctx.props.owner, this.ctx.props.repo, ref, { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }

      return {
        status: 200,
        headers: result.headers,
        data: normalizeCommitDetails(result.data),
      };
    });
  }

  /**
   * Resolve a ref to a full commit id for the session, without `getCommit`'s full-commit REST
   * read (whose response carries the commit's whole diff). Same simulation semantics: a branch
   * with queued pushes resolves to its simulated head, and a queued-push commit id GitHub does
   * not know yet is confirmed from the workspace git cache -- both reported as `fromCache`,
   * which the session must not advertise (see `getCommit`).
   */
  async resolveRef(refOrDefault: string | undefined, gitCache?: RpcStub<GitCache>)
      : Promise<{ id: GitOid; fromCache: boolean }> {
    const ref = refOrDefault ?? (await this.#getRepoMetadata()).defaultBranch;
    if (gitCache !== undefined && this.#pendingPushActions(ref).length > 0) {
      const realHead = await this.#getBranchHeadCached(ref);
      const simulated = this.#simulateBranchHead(ref, realHead);
      if (simulated !== null && simulated !== realHead) {
        // Confirm the commit is actually served by the cache's scoped view (as getCommit does)
        // before answering with an id GitHub does not know.
        const object = await gitCache.get(simulated);
        if (object !== null && object.type === "commit") {
          return { id: simulated, fromCache: true };
        }
      }
      if (realHead === null) {
        throw new Error(`No commit found for ref "${ref}".`);
      }
      // The overlay was a no-op; fall through to the real read.
    }

    try {
      return { id: await this.#resolveRemoteRef(ref), fromCache: false };
    } catch (error) {
      // A full commit id GitHub doesn't know yet may be queued for push; confirm it from the
      // workspace git cache so the caller sees the world as if the push had landed. As in
      // getCommit, GitHub's unknown-full-commit-id answer is 422, not 404; accept both.
      if (gitCache !== undefined && isCommitOid(ref) &&
          error instanceof GitHubApiError && (error.status === 404 || error.status === 422)) {
        const object = await gitCache.get(ref);
        if (object !== null && object.type === "commit") return { id: ref, fromCache: true };
      }
      throw error;
    }
  }

  async #resolveRemoteRef(ref: string): Promise<GitOid> {
    // Like #getRemoteCommitDetails: the resolution of a branch or tag name is mutable, hence the
    // short TTL.
    const cacheKey = this.#cacheKey("resolve-ref", stableKey(ref));
    return await this.#loadCachedWithEtag<GitOid>(cacheKey, ENTITY_CACHE_TTL_MS, async etag => {
      const result = await this.#withApi(api =>
        api.getCommitShaConditional(this.ctx.props.owner, this.ctx.props.repo, ref, { ifNoneMatch: etag })
      );
      if (result.status === 304) {
        return result;
      }

      const sha = result.data.trim();
      if (!isCommitOid(sha)) {
        throw new Error(`GitHub returned an unexpected response for ref "${ref}".`);
      }
      return { status: 200, headers: result.headers, data: sha };
    });
  }

  async listCommits(
    filter: GitHubCommitFilter | undefined,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubCommitSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;

    // A ref naming a branch with queued pushes enumerates from the simulated head: the pending
    // chain (locally filtered) is injected newest-first ahead of GitHub's listing, which starts
    // from the chain's anchor -- the first commit GitHub actually knows. Without this, a branch
    // a queued push creates 404s, and a moved one lists its stale history. An omitted ref means
    // the default branch (see GitHubCommitFilter.ref, matching GitHub's own default for the
    // listing endpoint), so it is resolved before the queued-push check -- otherwise a
    // parameterless listing after a queued default-branch push would show stale remote history
    // while getCommit()/resolveRef() already show the pending head. The metadata read is gated
    // on there being any queued push at all.
    let injected: GitHubCommitSummary[] = [];
    let startRef = filter?.ref;
    if (gitCache !== undefined && this.#pendingPushActions().length > 0) {
      const ref = filter?.ref ?? (await this.#getRepoMetadata()).defaultBranch;
      if (this.#pendingPushActions(ref).length > 0) {
        // From here on the listing names the resolved ref explicitly (simulation success
        // narrows it to the chain's anchor below): the pending check just consulted `ref`, and
        // a listing left to GitHub's live default could name a *different* branch than the one
        // simulated against if the default changed under the cached metadata -- disagreeing
        // with getCommit()/resolveRef(), which resolve from the same cache.
        startRef = ref;
        const realHead = await this.#getBranchHeadCached(ref);
        const simulatedHead = this.#simulateBranchHead(ref, realHead);
        if (simulatedHead !== null && simulatedHead !== realHead) {
          try {
            const chain = await this.#collectPendingChain(gitCache, simulatedHead);
            injected = await this.#filterPendingCommitsForListing(gitCache, chain, filter);
            startRef = chain.anchor;
          } catch (error) {
            logger.warn("failed to simulate a commit listing over queued pushes", {
              event: "commits.list.simulated.failed", error,
            });
            if (realHead === null) {
              throw new Error(
                `Branch "${ref}" does not exist on GitHub yet and the commits queued to ` +
                `create it could not be read. Retry, or list commits from an existing ref.`,
                { cause: error });
            }
          }
        }
      }
    }

    return new StreamingCursor<GitHubCommitSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("list-commits", stableKey({ ...filter, ref: startRef }), `p${page}`);
        return await this.#loadCachedWithEtag<GitHubCommitSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api => api.listCommitsConditional(owner, repo, {
            sha: startRef,
            path: filter?.path,
            author: filter?.author,
            since: filter?.since?.toISOString(),
            until: filter?.until?.toISOString(),
            page,
            per_page: perPage,
          }, { ifNoneMatch: etag }));
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeCommitSummary),
          };
        });
      },
      overlay: item => item,
      filter: () => true,
      // Injected pending commits are newer than everything the remote lists (newest-first).
      comparator: () => -1,
      injectedItems: injected,
      pageSize,
    });
  }

  /**
   * Apply a commit listing's filters to a pending chain locally, the way GitHub would have:
   * author matches the commit identity's name or email, since/until compare the committer date,
   * and path membership is decided by a tree diff against the commit's first parent.
   */
  async #filterPendingCommitsForListing(
    gitCache: RpcStub<GitCache>,
    chain: { commits: { summary: GitHubCommitSummary; tree: GitOid }[]; anchor: GitOid },
    filter: GitHubCommitFilter | undefined,
  ): Promise<GitHubCommitSummary[]> {
    const results: GitHubCommitSummary[] = [];
    for (let index = 0; index < chain.commits.length; index++) {
      const { summary, tree } = chain.commits[index];
      if (filter?.author !== undefined &&
          summary.author.email !== filter.author && summary.author.name !== filter.author) {
        continue;
      }
      const date = summary.committer.date ?? summary.author.date;
      if (filter?.since !== undefined && (date === undefined || date < filter.since)) continue;
      if (filter?.until !== undefined && (date === undefined || date > filter.until)) continue;
      if (filter?.path !== undefined) {
        const parentTree = index + 1 < chain.commits.length
          ? chain.commits[index + 1].tree
          : await this.#treeOidOfCommit(gitCache, chain.anchor);
        const changed =
          await changedPathsBetweenTrees(this.#treeDiffSource(gitCache), parentTree, tree);
        const path = filter.path.replace(/\/+$/, "");
        if (!changed.some(candidate => candidate === path || candidate.startsWith(`${path}/`))) {
          continue;
        }
      }
      results.push(summary);
    }
    return results;
  }

  async pullCommits(
    logicalId: string,
    pageSize: number,
    gitCache?: RpcStub<GitCache>,
  ): Promise<Cursor<GitHubCommitSummary>> {
    const owner = this.ctx.props.owner;
    const repo = this.ctx.props.repo;
    if (logicalId.startsWith("~") && !this.#resolveProvisionalId(logicalId)) {
      const action = this.#findCreateAction(logicalId, "pull") as CreatePullRequestAction | undefined;
      if (!action) {
        throw new Error(`Provisional pull request ${logicalId} is no longer available.`);
      }

      // The pull request doesn't exist on GitHub yet; simulate its commit list. When the head
      // branch has queued pushes, the spliced simulation is the truth (GitHub's compare would
      // 404 on a branch the queued push creates, or miss the pushed commits); otherwise the
      // branch comparison is, the same source #getDiff uses for provisional pull requests.
      const simulated = await this.#simulatedPullComparisonOrWarn(
        gitCache, action.options.base, action.options.head);
      if (simulated !== null) {
        return new ArrayCursor(simulated.commitSummaries, pageSize);
      }

      const cached = await this.#compareForProvisionalPull(
        this.#cacheKey("compare-provisional-v2", logicalId), action);
      return new ArrayCursor(cached.commits, pageSize);
    }

    const realId = logicalId.startsWith("~") ? this.#resolveProvisionalId(logicalId)! : logicalId;
    // An existing pull request whose head branch has queued pushes: list the simulated
    // comparison instead of the remote pages (a force push may even have replaced the listed
    // history, so splicing pages with the pending chain would misreport it).
    if (gitCache !== undefined && this.#pendingPushActions().length > 0) {
      const details = await this.#getRemotePullRequestDetails(realId);
      if (details.head.repo.fullName === this.#repoFullName() &&
          this.#pendingPushActions(details.head.ref).length > 0) {
        const simulated = await this.#simulatedPullComparisonOrWarn(
          gitCache, details.base.ref, details.head.ref);
        if (simulated !== null) {
          return new ArrayCursor(simulated.commitSummaries, pageSize);
        }
      }
    }
    return new StreamingCursor<GitHubCommitSummary>({
      fetchPage: async (page, perPage) => {
        const cacheKey = this.#cacheKey("pull-commits", realId, `p${page}`);
        return await this.#loadCachedWithEtag<GitHubCommitSummary[]>(cacheKey, LIST_CACHE_TTL_MS, async etag => {
          const raw = await this.#withApi(api =>
            api.listPullRequestCommitsConditional(owner, repo, Number(realId), page, perPage, { ifNoneMatch: etag })
          );
          if (raw.status === 304) {
            return raw;
          }

          return {
            status: 200,
            headers: raw.headers,
            data: raw.data.map(normalizeCommitSummary),
          };
        });
      },
      overlay: item => item,
      filter: () => true,
      comparator: () => 0,
      injectedItems: [],
      pageSize,
    });
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
    // Queue-time validation: both branches must exist -- on the remote, or as the not-yet-applied
    // outcome of queued pushes (`#simulateBranchHead` overlays those). Failing here surfaces a
    // typo'd or forgotten-to-push branch to the caller immediately, instead of queuing an action
    // GitHub will later refuse.
    for (const [role, branch] of [["head", options.head], ["base", options.base]] as const) {
      const realHead = await this.#getBranchHeadCached(branch);
      if (this.#simulateBranchHead(branch, realHead) === null) {
        throw new Error(role === "head"
          ? `Cannot create a pull request from branch "${branch}": the branch does not exist in ` +
            `${this.#repoFullName()}. Push your commits to the branch first (see push()), then ` +
            `create the pull request.`
          : `Cannot create a pull request into branch "${branch}": the base branch does not ` +
            `exist in ${this.#repoFullName()}.`);
      }
    }
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
   * Prepare a push action, binding the expected remote ref state at queue time: reads the
   * branch's current head and overlays this repo's earlier queued pushes (see
   * `#simulateBranchHead` -- stacked pushes bind each `expectedOldSha` to the previous push's
   * `newSha`, so approving them in order applies cleanly). Returns null when the (simulated)
   * branch is already at `commitId`: the desired end state already holds and there is no side
   * effect to queue.
   *
   * A non-force push must be a fast-forward: `expectedOldSha` must be an ancestor of `commitId`,
   * checked here -- before anything is queued -- by walking the workspace-cached commit chain
   * (`GitCache.isAncestor()`; the chain from an agent-authored commit down to a pulled base is
   * locally cached by construction). Branch creation is exempt (there is no old head to
   * fast-forward from; the zero-id compare-and-swap at apply protects against a branch appearing
   * in the interim), and `force` skips only this policy check -- it does not loosen the old-sha
   * match at apply.
   */
  async preparePush(branch: string, commitId: string, force: boolean,
                    gitCache: RpcStub<GitCache>): Promise<PushAction | null> {
    const realHead = await this.#withApi(api =>
      api.getBranchHead(this.ctx.props.owner, this.ctx.props.repo, branch));
    const expectedOldSha = this.#simulateBranchHead(branch, realHead) ?? ZERO_OID;
    if (expectedOldSha === commitId) return null;
    if (!force && expectedOldSha !== ZERO_OID &&
        !(await gitCache.isAncestor(expectedOldSha, commitId))) {
      throw new Error(
        `Cannot push to branch "${branch}": its current head ${expectedOldSha} is not an ` +
        `ancestor of ${commitId}, so this push is not a fast-forward -- the branch has moved ` +
        `past the head this work was based on. Pull the branch's new head and rebase onto it, ` +
        `or pass force: true to overwrite the branch.`);
    }
    return {
      type: "push",
      approvalId: this.#nextActionId(),
      submittedAt: Date.now(),
      owner: this.ctx.props.owner,
      repo: this.ctx.props.repo,
      branch,
      expectedOldSha,
      newSha: commitId,
      force,
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

// Exported (like the impls below) for the workerd wiring tests, which instantiate sessions
// directly against fake gatekeepers -- see __tests__/workerd/session-git.test.ts.
@validateRpc()
export class GitHubRepoSessionImpl extends RpcTarget implements GitHubRepoSession {
  #gatekeeper: GitHubGatekeeperImpl;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #gitCache: SessionGitCache;

  constructor(gatekeeper: GitHubGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
    this.#gitCache = new SessionGitCache(approvalQueue);
  }

  [Symbol.dispose](): void {
    this.#gitCache.dispose();
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
    // Queue-time validation reads both branches' current heads (see prepareCreatePullRequest).
    await this.#approvalQueue.authorizeObservation({
      title: `Read heads of branches ${options.head} and ${options.base}`,
      description: `Read the current heads of branches "${options.head}" and "${options.base}" ` +
        `in order to create a pull request from one into the other.`,
    });
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
    const details = await this.#gatekeeper.openPullRequest(id, await this.#gitCache.stub());
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
    const cursor = await this.#gatekeeper.listPullRequests(
      options, options?.resultsPerPage ?? 50, await this.#gitCache.stub());
    // Simulated ids -- heads of queued pushes, which listings show as if already pushed -- are
    // withheld from advertising: they are not on GitHub yet, and the hint would outlive a
    // rejection (see GitHubGatekeeperImpl.isSimulatedCommitId). Checked live per page, since a
    // push may be queued while the cursor is being drained.
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, pull =>
      commitIdsOfPullSummary(pull).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }

  async searchPullRequests(query: GitHubPullRequestSearch): Promise<Cursor<GitHubPullRequestSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `Search pull requests for "${query.text}"`,
      description: `Search pull requests in the GitHub repository for "${query.text}".`,
    });
    const cursor = await this.#gatekeeper.searchPullRequests(
      query, query.resultsPerPage ?? 50, await this.#gitCache.stub());
    // Simulated ids withheld from advertising, as in listPullRequests.
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, pull =>
      commitIdsOfPullSummary(pull).filter(id => !gatekeeper.isSimulatedCommitId(id)));
  }

  async listBranches(options?: GitHubBranchFilter): Promise<Cursor<GitHubBranchSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List branches`,
      description: `List branches in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listBranches(options, options?.resultsPerPage ?? 50);
    // A simulated head -- a queued push's commit, which the listing shows as if already pushed
    // -- is withheld from advertising: it is not on GitHub yet, and the hint would outlive a
    // rejection (see GitHubGatekeeperImpl.isSimulatedCommitId). Checked live per page, since a
    // push may be queued while the cursor is being drained.
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, branch =>
      gatekeeper.isSimulatedCommitId(branch.headCommit) ? [] : [branch.headCommit]);
  }

  async listTags(options?: GitHubPageOptions): Promise<Cursor<GitHubTagSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List tags`,
      description: `List tags in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listTags(options?.resultsPerPage ?? 50);
    return await this.#gitCache.wrap(cursor, tag => [tag.commit]);
  }

  async resolveRef(ref?: string): Promise<string> {
    const { id, fromCache } =
      await this.#gatekeeper.resolveRef(ref, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Resolve ${ref ?? "the default branch"} to a commit id`,
      description: `Resolve ${ref === undefined ? "the default branch" : `"${ref}"`}`
        + ` to commit ${id} in the GitHub repository.`,
    });
    // A cache-served resolution is never advertised, for the same reasons as getCommit.
    if (!fromCache) {
      await this.#gitCache.advertise([id]);
    }
    return id;
  }

  async getCommit(ref?: string): Promise<GitHubCommitDetails> {
    const { details, fromCache } =
      await this.#gatekeeper.getCommit(ref, await this.#gitCache.stub());
    await this.#approvalQueue.authorizeObservation({
      title: `Read commit ${details.id.slice(0, 12)}`,
      description: `Read commit ${details.id}`
        + `${ref === undefined ? " (head of the default branch)"
          : ref === details.id ? "" : ` (resolved from "${ref}")`} in the GitHub repository.`,
    });
    // A cache-served read is never advertised: either the commit was populated from this remote
    // in the first place (provenance already recorded; re-advertising is a no-op) or it is part
    // of a pending push (not on the remote yet -- the hint would outlive a rejection).
    if (!fromCache) {
      await this.#gitCache.advertise(commitIdsOfSummary(details));
    }
    return details;
  }

  async push(branch: string, commitId: string, options?: { force?: boolean }): Promise<void> {
    validateBranchName(branch);
    if (!isCommitOid(commitId)) {
      throw new Error(
        `push() requires a full 40-character commit id; got ${JSON.stringify(commitId)}. ` +
        `Use resolveRef() to resolve a truncated id.`);
    }
    // Binding the push's expected old head reads the branch's current state.
    await this.#approvalQueue.authorizeObservation({
      title: `Read head of branch ${branch}`,
      description: `Read the current head of branch "${branch}" in order to push to it.`,
    });
    const action = await this.#gatekeeper.preparePush(
      branch, commitId, options?.force ?? false, await this.#gitCache.stub());
    if (action === null) return;  // the branch is already at commitId: nothing to do
    const creating = action.expectedOldSha === ZERO_OID;
    await this.#gatekeeper.submitActionForApproval(this.#approvalQueue, action, {
      title: `Push ${commitId.slice(0, 12)} to ${branch}`,
      description: creating
        ? `Push commit ${commitId} to ${action.owner}/${action.repo}, creating branch "${branch}".`
        : `Push commit ${commitId} to branch "${branch}" of ${action.owner}/${action.repo}, ` +
          `moving the branch from its current head ${action.expectedOldSha}.` +
          (action.force ? " This is a force push: it rewrites the branch's history." : ""),
      pushedCommits: [commitId],
      implementsRevert: true,
    });
  }

  async listCommits(options?: GitHubCommitFilter): Promise<Cursor<GitHubCommitSummary>> {
    await this.#approvalQueue.authorizeObservation({
      title: `List commit history`,
      description: `List commits in the GitHub repository.`,
    });
    const cursor = await this.#gatekeeper.listCommits(
      options, options?.resultsPerPage ?? 50, await this.#gitCache.stub());
    // Pending (queued-push) commits in a simulated listing are withheld from advertising; their
    // GitHub-known parents still advertise.
    const gatekeeper = this.#gatekeeper;
    return await this.#gitCache.wrap(cursor, item =>
      commitIdsOfSummary(item).filter(id => !gatekeeper.isSimulatedCommitId(id)));
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
export class GitHubPullRequestImpl extends GitHubIssueImpl implements GitHubPullRequest {
  #gitCache: SessionGitCache;

  constructor(gatekeeper: GitHubGatekeeperImpl, approvalQueue: RpcStub<ApprovalQueue>, logicalId: string) {
    super(gatekeeper, approvalQueue, logicalId, "pull");
    this.#gitCache = new SessionGitCache(approvalQueue);
  }

  override [Symbol.dispose](): void {
    this.#gitCache.dispose();
    super[Symbol.dispose]();
  }

  async getDetails(): Promise<GitHubPullRequestDetails> {
    const details =
      await this.gatekeeper.openPullRequest(this.logicalId, await this.#gitCache.stub());
    await this.approvalQueue.authorizeObservation({
      title: `Read pull request #${details.id}: ${details.title}`,
      description: `Read the full details of pull request #${details.id} in ${details.repo.fullName}.`,
    });
    // A provisional pull request may carry empty branch shas (advertise() skips them) or a
    // simulated head -- a queued push's commit, withheld from advertising because it is not on
    // GitHub yet and the hint would outlive a rejection.
    await this.#gitCache.advertise(
      commitIdsOfPullSummary(details).filter(id => !this.gatekeeper.isSimulatedCommitId(id)));
    return details;
  }

  async readDiff(options?: GitHubPageOptions): Promise<GitHubPullRequestDiff> {
    await this.approvalQueue.authorizeObservation({
      title: `Read diff for #${this.logicalId}`,
      description: `Read the diff for pull request #${this.logicalId}.`,
    });
    const diff = await this.gatekeeper.pullDiff(
      this.logicalId, options?.resultsPerPage ?? 20, await this.#gitCache.stub());
    // A simulated head revision (a queued push's commit) is withheld from advertising.
    await this.#gitCache.advertise(
      [diff.revision.baseSha, diff.revision.headSha, diff.revision.mergeBaseSha ?? ""]
        .filter(id => !this.gatekeeper.isSimulatedCommitId(id)));
    return diff;
  }

  async getMergeBase(): Promise<string> {
    await this.approvalQueue.authorizeObservation({
      title: `Read merge base for #${this.logicalId}`,
      description: `Read the merge base commit of pull request #${this.logicalId}.`,
    });
    const mergeBase = await this.gatekeeper.pullMergeBase(
      this.logicalId, await this.#gitCache.stub());
    // A merge base is always a commit GitHub itself knows (see pullMergeBase), so it advertises
    // unconditionally.
    await this.#gitCache.advertise([mergeBase]);
    return mergeBase;
  }

  async listCommits(options?: GitHubPageOptions): Promise<Cursor<GitHubCommitSummary>> {
    await this.approvalQueue.authorizeObservation({
      title: `List commits for #${this.logicalId}`,
      description: `List the commits of pull request #${this.logicalId}.`,
    });
    const cursor = await this.gatekeeper.pullCommits(
      this.logicalId, options?.resultsPerPage ?? 50, await this.#gitCache.stub());
    // Pending (queued-push) commits in a simulated listing are withheld from advertising; their
    // GitHub-known parents still advertise. Checked live per page.
    const gatekeeper = this.gatekeeper;
    return await this.#gitCache.wrap(cursor, item =>
      commitIdsOfSummary(item).filter(id => !gatekeeper.isSimulatedCommitId(id)));
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
