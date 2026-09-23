// Pure git-object helpers behind a gatekeeper's git read APIs: commit-id validation, raw
// commit-object parsing (for simulating reads of commits that are queued for push but not yet on
// the remote, from their exact local bytes), and the commit-id advertising machinery that reports
// every returned commit id to the workspace git cache (`GitCache.advertiseCommit()`), so the
// overseer knows this gatekeeper's remote can supply those commits when one is later mounted as a
// worktree.
//
// Provider-neutral by construction: nothing here knows a REST response shape. A gatekeeper's own
// `normalize*` adapters map its provider's JSON onto its agent-facing types; this module covers
// what is the same for every git host.
//
// This module deliberately has no runtime imports (in particular no `cloudflare:workers`), so its
// logic runs under the kit's Node vitest project. A gatekeeper wraps `CommitAdvertisingCursor` in
// an `RpcTarget` cursor before handing it to callers.

import type { Cursor, GitOid } from "@gadgets/workshop-shared/gatekeeper";

/** The author or committer of a commit, as recorded in the commit object itself. */
export type GitCommitIdentity = {
  name?: string;
  email?: string;
  date?: Date;
};

/**
 * A commit's provider-independent details, as synthesized from its raw object by
 * `commitDetailsFromGitObject()`. A gatekeeper's agent-facing commit type is a superset (GitHub
 * adds `authorAccount` and `stats`, which only the provider can supply).
 */
export type GitCommitDetails = {
  /** The full git commit id (40 hex digits). */
  id: GitOid;
  /** The full commit message, without its trailing newline. */
  message: string;
  author: GitCommitIdentity;
  committer: GitCommitIdentity;
  /** Commit ids of this commit's parents: empty for a root commit, two or more for a merge. */
  parents: GitOid[];
  /** The provider web page where this commit can be viewed. */
  url: string;
};

/**
 * The commit ids a commit summary carries: the commit itself plus its parents. All of them were
 * returned to the caller, so all of them are advertised.
 */
export function commitIdsOfSummary(summary: { id: GitOid; parents: GitOid[] }): GitOid[] {
  return [summary.id, ...summary.parents];
}

/**
 * Whether `value` is a full commit id (SHA-1 repositories, so 40 hex digits). Used to skip
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
  author: GitCommitIdentity;
  committer: GitCommitIdentity;
  message: string;
};

/**
 * Parse a git commit object's payload (as returned by `GitCache.get()` -- no `<type> <size>\0`
 * header). Used to answer commit lookups for commits that are queued for push but not yet on the
 * remote, from their exact local bytes. Tolerant of headers it doesn't know (mergetag, gpgsig
 * with continuation lines, ...), but throws on anything that fails to parse as a commit at all.
 */
export function parseGitCommitPayload(payload: Uint8Array, oid: GitOid): ParsedGitCommit {
  const text = new TextDecoder().decode(payload);
  const separator = text.indexOf("\n\n");
  const headerText = separator === -1 ? text : text.slice(0, separator);
  const message = separator === -1 ? "" : text.slice(separator + 2);

  let tree: GitOid | undefined;
  const parents: GitOid[] = [];
  let author: GitCommitIdentity = {};
  let committer: GitCommitIdentity = {};
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

/**
 * Decode a commit's identity line value: `Name <email> <unix-seconds> <tz>`. Every field is
 * best-effort -- a malformed identity yields an empty one rather than failing the whole read.
 * The name runs to the first `<` (git itself strips angle brackets from names), and its trailing
 * whitespace is trimmed afterwards rather than by the pattern, which keeps the match linear.
 */
function parseGitIdentity(value: string): GitCommitIdentity {
  const match = /^([^<]*)<([^<>]*)>(?:\s+(\d+)(?:\s+[+-]\d{4})?)?$/.exec(value);
  if (!match) return {};
  return {
    name: match[1].trimEnd() || undefined,
    email: match[2] || undefined,
    date: match[3] ? new Date(Number(match[3]) * 1000) : undefined,
  };
}

/**
 * Synthesize a commit's details from a raw commit object, for reads served from the workspace git
 * cache while the commit is queued for push (simulation: it reads exactly as it will once
 * pushed). `commitUrl` builds the provider's web URL for a commit id (`/commit/<oid>` on GitHub,
 * `/-/commit/<oid>` on GitLab). Anything only the provider could add -- an account attribution,
 * diff stats -- is the caller's to layer on.
 */
export function commitDetailsFromGitObject(
  oid: GitOid,
  payload: Uint8Array,
  commitUrl: (oid: GitOid) => string,
): GitCommitDetails {
  const parsed = parseGitCommitPayload(payload, oid);
  return {
    id: oid,
    message: parsed.message.replace(/\n$/, ""),
    author: parsed.author,
    committer: parsed.committer,
    parents: parsed.parents,
    url: commitUrl(oid),
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
