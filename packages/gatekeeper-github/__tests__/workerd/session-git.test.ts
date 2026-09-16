// Wiring coverage for session-side commit advertising: every commit id a session read returns
// must be advertised to the workspace git cache, or a later attempt to mount it as a worktree
// fails as unknown. The pure helpers are tested in Node (git-commits.test.ts); only this suite can
// catch a session method that forgets to wrap its cursor or advertise its shas -- removing any
// `#gitCache.wrap()`/`#gitCache.advertise()` call in github.ts must fail this file.
//
// Sessions are instantiated directly against fake gatekeepers (the same shape as
// gatekeeper-cloudflare's workerd session suite): the REST/caching layer below the session is not
// under test here, only the session's own wiring.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import type { GitHubGatekeeperImpl } from "../../src/github";
import { GitHubPullRequestImpl, GitHubRepoSessionImpl } from "../../src/github";
import type {
  Cursor,
  GitHubCommitSummary,
  GitHubPullRequestSummary,
  GitHubRepoRef,
} from "../../src/types";

/** Deterministic fake full commit id. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

class TestGitCache extends RpcTarget {
  readonly advertised: string[] = [];

  async advertiseCommit(commitId: string): Promise<void> {
    this.advertised.push(commitId);
  }
}

class TestApprovalQueue extends RpcTarget {
  readonly observations: string[] = [];
  readonly cache = new TestGitCache();

  async authorizeObservation(entry: { title: string }): Promise<void> {
    this.observations.push(entry.title);
  }

  async getGitCache(): Promise<TestGitCache> {
    return this.cache;
  }
}

function queueStub(queue: TestApprovalQueue): RpcStub<ApprovalQueue> {
  return new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>;
}

/** A cursor over pre-baked pages, as the gatekeeper layer would return. */
function pagesCursor<T>(pages: T[][]): Cursor<T> {
  let index = 0;
  return {
    async next(): Promise<T[] | null> {
      return index >= pages.length ? null : pages[index++];
    },
  };
}

const REPO: GitHubRepoRef = {
  owner: "cloudflare",
  name: "workerd",
  fullName: "cloudflare/workerd",
  url: "https://github.com/cloudflare/workerd",
};

function pullSummary(id: number, headSha: string, baseSha: string): GitHubPullRequestSummary {
  return {
    repo: REPO,
    id: String(id),
    url: `${REPO.url}/pull/${id}`,
    title: `PR ${id}`,
    state: "open",
    labels: [],
    author: null,
    assignees: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    commentCount: 0,
    draft: false,
    merged: false,
    head: { ref: "feature", sha: headSha, repo: REPO },
    base: { ref: "main", sha: baseSha, repo: REPO },
  };
}

function commitSummary(id: string, parents: string[]): GitHubCommitSummary {
  return {
    id,
    message: `commit ${id.slice(0, 7)}`,
    author: {},
    committer: {},
    authorAccount: null,
    parents,
    url: `${REPO.url}/commit/${id}`,
  };
}

/**
 * The session only calls what the test drives, so each test supplies just those methods.
 * `isSimulatedCommitId` -- consulted by every advertising callback -- defaults to "nothing is
 * simulated"; tests exercising the withholding override it.
 */
function fakeGatekeeper(methods: Partial<Record<string, unknown>>): GitHubGatekeeperImpl {
  return { isSimulatedCommitId: () => false, ...methods } as unknown as GitHubGatekeeperImpl;
}

function repoSession(queue: TestApprovalQueue, methods: Partial<Record<string, unknown>>) {
  return new GitHubRepoSessionImpl(fakeGatekeeper(methods), queueStub(queue));
}

function pullSession(queue: TestApprovalQueue, id: string, methods: Partial<Record<string, unknown>>) {
  return new GitHubPullRequestImpl(fakeGatekeeper(methods), queueStub(queue), id);
}

describe("GitHubRepoSessionImpl advertising", () => {
  it("advertises head and base shas per fetched page of listPullRequests", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listPullRequests: async () => pagesCursor([
        [pullSummary(1, oid(1), oid(2))],
        [pullSummary(2, oid(3), oid(2))],
      ]),
    });

    const cursor = await session.listPullRequests();
    expect(await cursor.next()).toHaveLength(1);
    // Only the first page's shas: the second page hasn't been fetched.
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);

    expect(await cursor.next()).toHaveLength(1);
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
    expect(queue.observations).toEqual(["List pull requests"]);
  });

  it("advertises head and base shas from searchPullRequests, skipping empty provisional shas", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      searchPullRequests: async () => pagesCursor([
        [pullSummary(1, oid(1), oid(2)), pullSummary(2, "", "")],
      ]),
    });

    const cursor = await session.searchPullRequests({ text: "frobnicate" });
    expect(await cursor.next()).toHaveLength(2);
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("withholds a simulated pull request head sha from list and search advertising", async () => {
    // oid(1) is a queued push's commit standing in as the head of a provisional branch; only the
    // real base sha may be advertised.
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listPullRequests: async () => pagesCursor([[pullSummary(1, oid(1), oid(2))]]),
      searchPullRequests: async () => pagesCursor([[pullSummary(1, oid(1), oid(2))]]),
      isSimulatedCommitId: (id: string) => id === oid(1),
    });

    await (await session.listPullRequests()).next();
    expect(queue.cache.advertised).toEqual([oid(2)]);
    await (await session.searchPullRequests({ text: "x" })).next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(2), oid(2)]);
  });

  it("withholds pending commits from a simulated repo commit listing", async () => {
    // oid(1) is a pending chain commit; its parent oid(2) is the GitHub-known anchor.
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listCommits: async () => pagesCursor([
        [commitSummary(oid(1), [oid(2)]), commitSummary(oid(2), [oid(3)])],
      ]),
      isSimulatedCommitId: (id: string) => id === oid(1),
    });

    await (await session.listCommits({ ref: "feature" })).next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(2), oid(3)]);
  });

  it("advertises branch heads from listBranches", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listBranches: async () => pagesCursor([
        [{ name: "main", headCommit: oid(1), protected: true }],
      ]),
    });

    const cursor = await session.listBranches();
    await cursor.next();
    expect(queue.cache.advertised).toEqual([oid(1)]);
  });

  it("withholds a simulated branch head (a queued push's commit) from advertising", async () => {
    const queue = new TestApprovalQueue();
    // The listing shows oid(2) as `main`'s head because a queued push overlays it; that commit
    // is not on GitHub yet, so advertising it would record a wrong pull-routing hint that
    // outlives a rejection.
    const session = repoSession(queue, {
      listBranches: async () => pagesCursor([
        [
          { name: "main", headCommit: oid(2), protected: false },
          { name: "other", headCommit: oid(1), protected: false },
        ],
      ]),
      isSimulatedCommitId: (id: string) => id === oid(2),
    });

    const cursor = await session.listBranches();
    await cursor.next();
    expect(queue.cache.advertised).toEqual([oid(1)]);
  });

  it("advertises tag commits from listTags", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listTags: async () => pagesCursor([
        [{ name: "v1.0.0", commit: oid(1) }],
      ]),
    });

    const cursor = await session.listTags();
    await cursor.next();
    expect(queue.cache.advertised).toEqual([oid(1)]);
  });

  it("advertises commit ids and parents from listCommits", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      listCommits: async () => pagesCursor([
        [commitSummary(oid(1), [oid(2)])],
      ]),
    });

    const cursor = await session.listCommits();
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises the resolved commit and its parents from getCommit", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      getCommit: async () => ({ details: commitSummary(oid(1), [oid(2), oid(3)]), fromCache: false }),
    });

    const details = await session.getCommit("abc1234");
    expect(details.id).toBe(oid(1));
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("does not advertise a cache-served getCommit result", async () => {
    const queue = new TestApprovalQueue();
    // A cache-served read is either already-recorded provenance or a pending push; the session
    // must advertise neither the commit nor its parents.
    const session = repoSession(queue, {
      getCommit: async () => ({ details: commitSummary(oid(1), [oid(2)]), fromCache: true }),
    });

    const details = await session.getCommit(oid(1));
    expect(details.id).toBe(oid(1));
    expect(queue.cache.advertised).toEqual([]);
  });

  it("advertises the commit id resolved by resolveRef", async () => {
    const queue = new TestApprovalQueue();
    const session = repoSession(queue, {
      resolveRef: async () => ({ id: oid(1), fromCache: false }),
    });

    expect(await session.resolveRef("main")).toBe(oid(1));
    expect(queue.cache.advertised).toEqual([oid(1)]);
    expect(queue.observations).toEqual(["Resolve main to a commit id"]);
  });

  it("does not advertise a cache-served resolveRef result", async () => {
    const queue = new TestApprovalQueue();
    // Cache-served = a queued push's simulated head or an unpushed commit id: not on GitHub yet.
    const session = repoSession(queue, {
      resolveRef: async () => ({ id: oid(1), fromCache: true }),
    });

    expect(await session.resolveRef()).toBe(oid(1));
    expect(queue.cache.advertised).toEqual([]);
    expect(queue.observations).toEqual(["Resolve the default branch to a commit id"]);
  });
});

describe("GitHubRepoSessionImpl push", () => {
  function pushFakes() {
    const prepared: unknown[][] = [];
    const submitted: { action: { type: string }, description: { pushedCommits?: string[] } }[] = [];
    const methods = {
      preparePush: async (branch: string, commitId: string, force: boolean, cache: unknown) => {
        prepared.push([branch, commitId, force, cache]);
        return {
          type: "push", approvalId: 1, submittedAt: 0, owner: "cloudflare", repo: "workerd",
          branch, expectedOldSha: oid(9), newSha: commitId, force,
        };
      },
      submitActionForApproval: async (
        _queue: unknown, action: { type: string }, description: { pushedCommits?: string[] },
      ) => {
        submitted.push({ action, description });
      },
    };
    return { prepared, submitted, methods };
  }

  it("records the branch-head observation and declares the pushed commit", async () => {
    const queue = new TestApprovalQueue();
    const { prepared, submitted, methods } = pushFakes();
    const session = repoSession(queue, methods);

    await session.push("main", oid(1));

    expect(queue.observations).toEqual(["Read head of branch main"]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].slice(0, 3)).toEqual(["main", oid(1), false]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].description.pushedCommits).toEqual([oid(1)]);
  });

  it("submits nothing when the branch is already at the commit", async () => {
    const queue = new TestApprovalQueue();
    const { submitted, methods } = pushFakes();
    const session = repoSession(queue, {
      ...methods,
      preparePush: async () => null,  // the gatekeeper found the desired state already holds
    });

    await session.push("main", oid(1));
    expect(submitted).toEqual([]);
  });

  it("rejects a truncated commit id and a bad branch name before reading anything", async () => {
    const queue = new TestApprovalQueue();
    const { prepared, methods } = pushFakes();
    const session = repoSession(queue, methods);

    await expect(session.push("main", "abc1234")).rejects.toThrow(/full 40-character commit id/);
    await expect(session.push("bad name", oid(1))).rejects.toThrow(/invalid branch name/);
    expect(queue.observations).toEqual([]);
    expect(prepared).toEqual([]);
  });
});

describe("GitHubPullRequestImpl advertising", () => {
  it("advertises the head and base shas returned by getDetails", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      openPullRequest: async () => ({
        ...pullSummary(1, oid(1), oid(2)),
        bodyMarkdown: "",
        requestedReviewers: [],
        commits: 1,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      }),
    });

    await session.getDetails();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises the revision shas returned by readDiff, including the merge base", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      pullDiff: async () => ({
        revision: { baseSha: oid(1), headSha: oid(2), mergeBaseSha: oid(3) },
        files: pagesCursor([]),
      }),
    });

    await session.readDiff();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("advertises a revision with no merge base", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      pullDiff: async () => ({
        revision: { baseSha: oid(1), headSha: oid(2) },
        files: pagesCursor([]),
      }),
    });

    await session.readDiff();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("advertises the merge base returned by getMergeBase", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      pullMergeBase: async () => oid(5),
    });

    expect(await session.getMergeBase()).toBe(oid(5));
    expect(queue.cache.advertised).toEqual([oid(5)]);
    expect(queue.observations).toEqual(["Read merge base for #1"]);
  });

  it("advertises commit ids and parents per fetched page of listCommits", async () => {
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      pullCommits: async () => pagesCursor([
        [commitSummary(oid(1), [oid(2)])],
        [commitSummary(oid(3), [])],
      ]),
    });

    const cursor = await session.listCommits();
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("withholds a simulated head from getDetails and readDiff advertising", async () => {
    // oid(1) is a queued push's commit simulating the pull request's head; only the base sha is
    // real, so only it may be advertised.
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "1", {
      openPullRequest: async () => ({
        ...pullSummary(1, oid(1), oid(2)),
        bodyMarkdown: "",
        requestedReviewers: [],
        commits: 1,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      }),
      pullDiff: async () => ({
        revision: { baseSha: oid(2), headSha: oid(1) },
        files: pagesCursor([]),
      }),
      isSimulatedCommitId: (id: string) => id === oid(1),
    });

    await session.getDetails();
    expect(queue.cache.advertised).toEqual([oid(2)]);
    await session.readDiff();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(2), oid(2)]);
  });

  it("withholds pending chain commits from a simulated pull commit listing", async () => {
    // The provisional pull request's commit list splices GitHub-known commits (oid(3), and the
    // anchor oid(2) as a parent) with pending ones (oid(1)); only real ids advertise.
    const queue = new TestApprovalQueue();
    const session = pullSession(queue, "~1", {
      pullCommits: async () => pagesCursor([
        [commitSummary(oid(3), []), commitSummary(oid(1), [oid(2)])],
      ]),
      isSimulatedCommitId: (id: string) => id === oid(1),
    });

    const cursor = await session.listCommits();
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(2), oid(3)]);
  });
});
