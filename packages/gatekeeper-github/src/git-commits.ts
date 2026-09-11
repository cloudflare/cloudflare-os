// GitHub-specific helpers behind the gatekeeper's git read APIs (see types.d.ts: listBranches,
// listTags, getCommit, listCommits): normalization of the REST commit/branch/tag responses into
// the agent-facing types. The provider-neutral half -- commit-id validation, raw commit-object
// parsing, and the per-page commit advertising cursor -- lives in
// `@gadgets/gatekeeper-kit/git-objects`, shared with the other git-host gatekeepers.
//
// This module deliberately has no runtime imports (in particular no `cloudflare:workers`), so its
// logic runs under the package's Node vitest project.

import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { commitDetailsFromGitObject as neutralCommitDetailsFromGitObject } from "@gadgets/gatekeeper-kit/git-objects";
import type {
  GitHubBranchResponse,
  GitHubCommitResponse,
  GitHubGitIdentityResponse,
  GitHubTagResponse,
} from "./github-api";
import type {
  GitHubActor,
  GitHubBranchSummary,
  GitHubCommitDetails,
  GitHubCommitIdentity,
  GitHubCommitSummary,
  GitHubTagSummary,
} from "./types";

export function actorFromUser(
  user: { login: string; name?: string | null; html_url: string; avatar_url?: string } | null | undefined,
): GitHubActor | null {
  if (!user) return null;
  return {
    login: user.login,
    displayName: user.name ?? undefined,
    url: user.html_url,
    avatarUrl: user.avatar_url,
  };
}

function identityFromResponse(identity?: GitHubGitIdentityResponse | null): GitHubCommitIdentity {
  return {
    name: identity?.name ?? undefined,
    email: identity?.email ?? undefined,
    date: identity?.date ? new Date(identity.date) : undefined,
  };
}

export function normalizeCommitSummary(response: GitHubCommitResponse): GitHubCommitSummary {
  return {
    id: response.sha,
    message: response.commit.message,
    author: identityFromResponse(response.commit.author),
    committer: identityFromResponse(response.commit.committer),
    authorAccount: actorFromUser(response.author),
    parents: response.parents.map(parent => parent.sha),
    url: response.html_url,
  };
}

export function normalizeCommitDetails(response: GitHubCommitResponse): GitHubCommitDetails {
  return {
    ...normalizeCommitSummary(response),
    stats: response.stats
      ? {
          additions: response.stats.additions,
          deletions: response.stats.deletions,
          total: response.stats.total,
        }
      : undefined,
  };
}

export function normalizeBranchSummary(response: GitHubBranchResponse): GitHubBranchSummary {
  return {
    name: response.name,
    headCommit: response.commit.sha,
    protected: response.protected ?? false,
  };
}

export function normalizeTagSummary(response: GitHubTagResponse): GitHubTagSummary {
  return {
    name: response.name,
    commit: response.commit.sha,
  };
}

/**
 * The commit ids a pull request summary (or details) carries: its head and base branch shas.
 * A provisional pull request's shas may be empty; `advertiseCommits()` skips those.
 */
export function commitIdsOfPullSummary(pull: { head: { sha: string }; base: { sha: string } }): GitOid[] {
  return [pull.head.sha, pull.base.sha];
}

/**
 * Synthesize the `GitHubCommitDetails` shape from a raw commit object, for reads served from the
 * workspace git cache while the commit is queued for push (simulation: it reads exactly as it
 * will once pushed). `authorAccount` is unknowable without GitHub's attribution, and `stats`
 * would require diffing, so both are omitted -- their types are nullable/optional for this
 * reason.
 */
export function commitDetailsFromGitObject(
  oid: GitOid,
  payload: Uint8Array,
  repoUrl: string,
): GitHubCommitDetails {
  return {
    ...neutralCommitDetailsFromGitObject(oid, payload, id => `${repoUrl}/commit/${id}`),
    authorAccount: null,
  };
}
