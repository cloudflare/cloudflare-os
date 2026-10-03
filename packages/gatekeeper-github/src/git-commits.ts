// Pure helpers behind the GitHub gatekeeper's git read APIs (see types.d.ts: listBranches,
// listTags, getCommit, listCommits): normalization of the REST commit/branch/tag responses into
// the agent-facing types, plus the commit-id advertising machinery that reports every returned
// commit id to the workspace git cache (`GitCache.advertiseCommit()`), so the overseer knows this
// gatekeeper's remote can supply those commits when one is later mounted as a worktree.
//
// This module deliberately has no runtime imports (in particular no `cloudflare:workers`), so its
// logic runs under the package's Node vitest project. github.ts wraps `CommitAdvertisingCursor`
// in an `RpcTarget` cursor before handing it to callers.

import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitHubBranchResponse,
  GitHubCommitResponse,
  GitHubGitIdentityResponse,
  GitHubTagResponse,
} from "./github-api";
import type {
  Cursor,
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
 * The commit ids a `GitHubCommitSummary` carries: the commit itself plus its parents. All of them
 * were returned to the caller, so all of them are advertised.
 */
export function commitIdsOfSummary(summary: GitHubCommitSummary): GitOid[] {
  return [summary.id, ...summary.parents];
}

/**
 * The commit ids a pull request summary (or details) carries: its head and base branch shas.
 * A provisional pull request's shas may be empty; `advertiseCommits()` skips those.
 */
export function commitIdsOfPullSummary(pull: { head: { sha: string }; base: { sha: string } }): GitOid[] {
  return [pull.head.sha, pull.base.sha];
}

/**
 * Whether `value` is a full commit id (GitHub repos are SHA-1, so 40 hex digits). Used to skip
 * advertising placeholder values -- e.g. a provisional pull request whose branch comparison
 * failed carries an empty `sha`.
 */
export function isCommitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * The one method of `GitCache` this module needs; structural so both an `RpcStub<GitCache>` and a
 * test fake satisfy it.
 */
export type CommitAdvertiser = {
  advertiseCommit(commitId: GitOid): Promise<void>;
};

/**
 * Advertise the given commit ids (deduplicated, in parallel -- `advertiseCommit()` has no batch
 * form by design; the stub is always local). Values that are not full commit ids are skipped, and
 * ids present in `alreadyAdvertised` are skipped and newly advertised ones added to it, letting a
 * cursor avoid re-advertising across pages.
 */
export async function advertiseCommits(
  advertiser: CommitAdvertiser,
  ids: Iterable<GitOid>,
  alreadyAdvertised?: Set<GitOid>,
): Promise<void> {
  const batch = new Set<GitOid>();
  for (const id of ids) {
    if (!isCommitOid(id)) continue;
    if (alreadyAdvertised) {
      if (alreadyAdvertised.has(id)) continue;
      alreadyAdvertised.add(id);
    }
    batch.add(id);
  }
  await Promise.all([...batch].map(id => advertiser.advertiseCommit(id)));
}

// =======================================================================================
// Raw commit-object parsing (for simulating reads of commits queued for push)

/** A raw git commit object's decoded headers and message. */
export type ParsedGitCommit = {
  tree: GitOid;
  parents: GitOid[];
  author: GitHubCommitIdentity;
  committer: GitHubCommitIdentity;
  message: string;
};

/**
 * Parse a git commit object's payload (as returned by `GitCache.get()` -- no `<type> <size>\0`
 * header). Used to answer commit lookups for commits that are queued for push but not yet on
 * GitHub, from their exact local bytes. Tolerant of headers it doesn't know (mergetag, gpgsig
 * with continuation lines, ...), but throws on anything that fails to parse as a commit at all.
 */
export function parseGitCommitPayload(payload: Uint8Array, oid: GitOid): ParsedGitCommit {
  const text = new TextDecoder().decode(payload);
  const separator = text.indexOf("\n\n");
  const headerText = separator === -1 ? text : text.slice(0, separator);
  const message = separator === -1 ? "" : text.slice(separator + 2);

  let tree: GitOid | undefined;
  const parents: GitOid[] = [];
  let author: GitHubCommitIdentity = {};
  let committer: GitHubCommitIdentity = {};
  for (const line of headerText.split("\n")) {
    if (line.startsWith(" ")) continue;  // continuation of a multi-line header (e.g. gpgsig)
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    switch (key) {
      case "tree":
        if (tree !== undefined || !isCommitOid(value)) {
          throw new Error(`git object ${oid} is not a well-formed commit`);
        }
        tree = value;
        break;
      case "parent":
        if (!isCommitOid(value)) {
          throw new Error(`git object ${oid} is not a well-formed commit`);
        }
        parents.push(value);
        break;
      case "author":
        author = parseGitIdentity(value);
        break;
      case "committer":
        committer = parseGitIdentity(value);
        break;
      default:
        break;  // unknown headers are fine
    }
  }
  if (tree === undefined) {
    throw new Error(`git object ${oid} is not a well-formed commit`);
  }
  return { tree, parents, author, committer, message };
}

// Decodes a commit's identity line value: `Name <email> <unix-seconds> <tz>`. Every field is
// best-effort -- a malformed identity yields an empty one rather than failing the whole read.
function parseGitIdentity(value: string): GitHubCommitIdentity {
  const match = /^(.*?)\s*<([^<>]*)>(?:\s+(\d+)(?:\s+[+-]\d{4})?)?$/.exec(value);
  if (!match) return {};
  return {
    name: match[1] || undefined,
    email: match[2] || undefined,
    date: match[3] ? new Date(Number(match[3]) * 1000) : undefined,
  };
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
  const parsed = parseGitCommitPayload(payload, oid);
  return {
    id: oid,
    message: parsed.message.replace(/\n$/, ""),
    author: parsed.author,
    committer: parsed.committer,
    authorAccount: null,
    parents: parsed.parents,
    url: `${repoUrl}/commit/${oid}`,
  };
}

/**
 * Cursor wrapper that advertises the commit ids on each page before returning it.
 *
 * The underlying session methods authorize their observation once, up front, and then fetch pages
 * lazily -- so at method-call time no commit ids exist to advertise. Advertising per page keeps
 * listings lazy and bounds the metadata written by how far the caller actually iterates: pages
 * never fetched are never advertised, and a page bearing no commit ids advertises nothing. (An
 * advertisement is workspace-internal pull-routing metadata, not a read, so no observation
 * accompanies a page fetch.)
 */
export class CommitAdvertisingCursor<T> implements Cursor<T> {
  #inner: Cursor<T>;
  #advertiser: CommitAdvertiser;
  #commitIds: (item: T) => GitOid[];
  #advertised = new Set<GitOid>();

  constructor(inner: Cursor<T>, advertiser: CommitAdvertiser, commitIds: (item: T) => GitOid[]) {
    this.#inner = inner;
    this.#advertiser = advertiser;
    this.#commitIds = commitIds;
  }

  async next(): Promise<T[] | null> {
    const page = await this.#inner.next();
    if (page !== null) {
      await advertiseCommits(
        this.#advertiser,
        page.flatMap(item => this.#commitIds(item)),
        this.#advertised,
      );
    }
    return page;
  }
}
