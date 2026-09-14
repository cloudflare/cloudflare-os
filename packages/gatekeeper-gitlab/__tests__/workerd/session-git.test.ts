// Wiring coverage for session-side commit advertising: every commit id a session read returns
// must be advertised to the workspace git cache, or a later attempt to mount it as a worktree
// fails as unknown. Only this suite can catch a session method that forgets to wrap its cursor
// or advertise its shas -- removing any `#gitCache.wrap()`/`#gitCache.advertise()` call in
// gitlab-sessions.ts must fail this file. Sessions are instantiated directly against fake
// gatekeepers; the REST/caching layer below is not under test here.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import type { GitLabGatekeeperImpl } from "../../src/gitlab-gatekeeper";
import { GitLabMergeRequestImpl, GitLabProjectSessionImpl } from "../../src/gitlab-sessions";
import type { Cursor, GitLabCommitSummary, GitLabMergeRequestSummary, GitLabProjectRef } from "../../src/types";

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

function pagesCursor<T>(pages: T[][]): Cursor<T> {
  let index = 0;
  return { async next() { return index >= pages.length ? null : pages[index++]; } };
}

async function drain<T>(cursor: Cursor<T>): Promise<T[]> {
  const items: T[] = [];
  for (let page = await cursor.next(); page !== null; page = await cursor.next()) items.push(...page);
  return items;
}

const PROJECT: GitLabProjectRef = { path: "group/project", name: "project", namespace: "group", url: "https://gitlab.example.com/group/project" };

function mrSummary(id: number, sourceSha: string, targetSha: string): GitLabMergeRequestSummary {
  return {
    project: PROJECT, id: String(id), url: `${PROJECT.url}/-/merge_requests/${id}`, title: `MR ${id}`,
    state: "opened", labels: [], author: null, assignees: [], createdAt: new Date(0), updatedAt: new Date(0), commentCount: 0,
    draft: false,
    source: { branch: "feature", sha: sourceSha, project: PROJECT },
    target: { branch: "main", sha: targetSha, project: PROJECT },
  };
}

function commitSummary(id: string, parents: string[]): GitLabCommitSummary {
  return { id, message: `commit ${id.slice(0, 7)}`, author: {}, committer: {}, parents, url: `${PROJECT.url}/-/commit/${id}` };
}

function fakeGatekeeper(methods: Partial<Record<string, unknown>>): GitLabGatekeeperImpl {
  return { isSimulatedCommitId: () => false, ...methods } as unknown as GitLabGatekeeperImpl;
}

function projectSession(queue: TestApprovalQueue, methods: Partial<Record<string, unknown>>) {
  return new GitLabProjectSessionImpl(fakeGatekeeper(methods), queueStub(queue));
}

function mrSession(queue: TestApprovalQueue, id: string, methods: Partial<Record<string, unknown>>) {
  return new GitLabMergeRequestImpl(fakeGatekeeper(methods), queueStub(queue), id);
}

describe("page size", () => {
  it("passes a caller's resultsPerPage through capped at one remote page, defaults to 50, and refuses what no cursor can serve", async () => {
    const sizes: number[] = [];
    const session = projectSession(new TestApprovalQueue(), {
      listBranches: async (_filter: unknown, pageSize: number) => { sizes.push(pageSize); return pagesCursor([]); },
    });
    await session.listBranches();
    await session.listBranches({ resultsPerPage: 7 });
    await session.listBranches({ resultsPerPage: 1000 });
    expect(sizes).toEqual([50, 7, 100]);
    // A zero page would make the streaming cursor answer null at once (hiding every row) and the
    // array cursor answer [] forever; neither is a page size, so the call is refused up front.
    for (const resultsPerPage of [0, -1, 2.5, Number.NaN]) {
      await expect(session.listBranches({ resultsPerPage })).rejects.toThrow(/resultsPerPage must be a positive integer/);
    }
    expect(sizes).toHaveLength(3);
  });

  it("checks the merge request's diff reads the same way, with their smaller default", async () => {
    const sizes: number[] = [];
    const queue = new TestApprovalQueue();
    const session = mrSession(queue, "7", {
      mergeRequestDiff: async (_id: string, pageSize: number) => { sizes.push(pageSize); return { revision: { baseSha: oid(1), headSha: oid(2) }, files: pagesCursor([]) }; },
      mergeRequestThreads: async (_id: string, pageSize: number) => { sizes.push(pageSize); return pagesCursor([]); },
    });
    await session.readDiff();
    await session.readDiffThreads();
    await session.readDiff({ resultsPerPage: 500 });
    expect(sizes).toEqual([20, 20, 100]);
    await expect(session.readDiff({ resultsPerPage: 0 })).rejects.toThrow(/resultsPerPage must be a positive integer/);
    await expect(session.readDiffThreads({ resultsPerPage: 0 })).rejects.toThrow(/resultsPerPage must be a positive integer/);
  });
});

describe("GitLabProjectSessionImpl advertising", () => {
  it("advertises source and target shas per fetched page of listMergeRequests, withholding simulated ones", async () => {
    const queue = new TestApprovalQueue();
    const session = projectSession(queue, {
      listMergeRequests: async () => pagesCursor([[mrSummary(1, oid(1), oid(2))], [mrSummary(2, oid(3), oid(2))]]),
      isSimulatedCommitId: (id: string) => id === oid(3),
    });
    const cursor = await session.listMergeRequests();
    await cursor.next();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    await drain(cursor);
    // oid(3) is a queued push's head: withheld. oid(2) not re-advertised.
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    expect(queue.observations).toEqual(["List merge requests"]);
  });

  it("advertises branch heads, tags, and history commits (with parents) per page", async () => {
    const queue = new TestApprovalQueue();
    const session = projectSession(queue, {
      listBranches: async () => pagesCursor([[{ name: "main", headCommit: oid(1), protected: true, default: true }]]),
      listTags: async () => pagesCursor([[{ name: "v1", commit: oid(2) }]]),
      listCommits: async () => pagesCursor([[commitSummary(oid(3), [oid(4)])]]),
    });
    await drain(await session.listBranches());
    await drain(await session.listTags());
    await drain(await session.listCommits());
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(3), oid(4)]);
  });

  it("advertises getCommit and resolveRef results only when served from GitLab", async () => {
    const queue = new TestApprovalQueue();
    const session = projectSession(queue, {
      getCommit: async (ref: string) => ({ details: commitSummary(oid(1), [oid(2)]), fromCache: ref === "pending" }),
      resolveRef: async (ref: string) => ({ id: oid(5), fromCache: ref === "pending" }),
    });
    await session.getCommit("main");
    await session.resolveRef("main");
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2), oid(5)]);
    await session.getCommit("pending");
    await session.resolveRef("pending");
    expect(queue.cache.advertised).toHaveLength(3);
    expect(queue.observations).toEqual([
      `Read commit ${oid(1).slice(0, 12)}`, "Resolve main to a commit id",
      `Read commit ${oid(1).slice(0, 12)}`, "Resolve pending to a commit id",
    ]);
  });

  it("records an observation before queuing a push and declares pushedCommits", async () => {
    const queue = new TestApprovalQueue();
    const submitted: unknown[] = [];
    const session = projectSession(queue, {
      preparePush: async () => ({ type: "push", approvalId: 1, submittedAt: 0, projectPath: "group/project", branch: "main", expectedOldSha: oid(1), newSha: oid(2), force: false }),
      submitActionForApproval: async (_q: unknown, action: unknown, description: unknown) => { submitted.push({ action, description }); },
    });
    await session.push("main", oid(2));
    expect(queue.observations).toEqual(["Read head of branch main"]);
    expect(submitted[0]).toMatchObject({ description: { pushedCommits: [oid(2)], implementsRevert: true } });
    await expect(session.push("main", "abc123")).rejects.toThrow(/full 40-character commit id/);
    await expect(session.push("bad..name", oid(2))).rejects.toThrow();
  });
});

describe("GitLabMergeRequestImpl advertising", () => {
  it("advertises the revision shas of readDiff and the merge base, and details' branch shas", async () => {
    const queue = new TestApprovalQueue();
    const session = mrSession(queue, "7", {
      openMergeRequest: async () => ({ ...mrSummary(7, oid(1), oid(2)), bodyMarkdown: "", mergeStatus: "mergeable", hasConflicts: false, reviewers: [], approvedBy: [] }),
      mergeRequestDiff: async () => ({ revision: { baseSha: oid(2), headSha: oid(1), mergeBaseSha: oid(3) }, files: pagesCursor([]) }),
      mergeRequestMergeBase: async () => oid(3),
      mergeRequestCommits: async () => pagesCursor([[commitSummary(oid(4), [oid(3)])]]),
    });
    await session.getDetails();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    await session.readDiff();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(1), oid(2), oid(2), oid(3)]);
    await session.getMergeBase();
    await drain(await session.listCommits());
    expect(queue.cache.advertised.filter(id => id === oid(4))).toHaveLength(1);
  });

  it("records the preparatory read before queuing a merge, and names the bound head to the approver", async () => {
    const queue = new TestApprovalQueue();
    const submitted: Array<{ description: { description: string } }> = [];
    const session = mrSession(queue, "7", {
      prepareMergeMergeRequest: async (id: string, options: unknown) =>
        ({ type: "mergeMergeRequest", approvalId: 1, submittedAt: 0, projectPath: "group/project", mergeRequestId: id, options, expectedHeadSha: oid(9) }),
      submitActionForApproval: async (_q: unknown, _action: unknown, description: { description: string }) => { submitted.push({ description }); },
    });
    await session.merge({ squash: true });
    expect(queue.observations).toEqual(["Read current state of !7"]);
    expect(submitted[0].description.description).toBe(
      `Merge merge request !7 at its current head ${oid(9)}, squashing its commits. ` +
      "The merge is refused if the head has moved by the time it applies.");
  });
});
