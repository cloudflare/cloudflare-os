// Wiring coverage for session-side commit advertising: every commit id a session read returns
// must be advertised to the workspace git cache, or a later attempt to mount it as a worktree
// fails as unknown. Only this suite can catch a session method that forgets to wrap its cursor
// or advertise its shas -- removing any `#gitCache.wrap()`/`#gitCache.advertise()` call in
// gitlab-sessions.ts must fail this file. It also checks which subresource each code-only read
// reports (the repository), that a file read advertises the commit it was read at once
// authorized, and that metadata, listings and code search, served through gitlab-code.ts,
// advertise nothing. Sessions are instantiated directly against fake gatekeepers; the
// REST/caching layer below is not under test here.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import type { GitLabApi } from "../../src/gitlab-api";
import { CodeCaches, type CodeReadContext } from "../../src/gitlab-code";
import type { GitLabGatekeeperImpl } from "../../src/gitlab-gatekeeper";
import { GitLabMergeRequestImpl, GitLabProjectSessionImpl } from "../../src/gitlab-sessions";
import type { Cursor, GitLabCommitSummary, GitLabMergeRequestSummary, GitLabProjectRef } from "../../src/types";

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/** What the session asked of the queue and the git cache, in order: `authorize <title>` / `advertise <id>`. */
type EventLog = string[];

class TestGitCache extends RpcTarget {
  readonly advertised: string[] = [];
  constructor(readonly events: EventLog) { super(); }
  async advertiseCommit(commitId: string): Promise<void> {
    this.advertised.push(commitId);
    this.events.push(`advertise ${commitId}`);
  }
}

class TestApprovalQueue extends RpcTarget {
  readonly observations: string[] = [];
  readonly subresources: string[][] = [];
  readonly events: EventLog = [];
  readonly cache = new TestGitCache(this.events);
  async authorizeObservation(entry: { title: string; subresources: string[] }): Promise<void> {
    this.observations.push(entry.title);
    this.subresources.push(entry.subresources);
    this.events.push(`authorize ${entry.title}`);
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

/** The subresource the fake gatekeepers report for a read that names none: the bound project. */
const BOUND = "project/1";
/** What the fake gatekeepers report for a code-only read: the bound project's repository. */
const REPOSITORY = "repository/1";

function fakeGatekeeper(methods: Partial<Record<string, unknown>>): GitLabGatekeeperImpl {
  return {
    isSimulatedCommitId: () => false,
    // As GitLabGatekeeperImpl.authorizeRead: forward the observation with the subresource it depends on.
    authorizeRead: async (queue: RpcStub<ApprovalQueue>, observation: object, subresource?: string) =>
      await queue.authorizeObservation({ ...observation, subresources: [subresource ?? BOUND] } as never),
    repositorySubresource: async () => REPOSITORY,
    ...methods,
  } as unknown as GitLabGatekeeperImpl;
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
  it("authorizes and then advertises source and target shas per fetched page of listMergeRequests, withholding simulated ones", async () => {
    const queue = new TestApprovalQueue();
    const session = projectSession(queue, {
      listMergeRequests: async () => pagesCursor([[mrSummary(1, oid(1), oid(2))], [mrSummary(2, oid(3), oid(2))]]),
      isSimulatedCommitId: (id: string) => id === oid(3),
    });
    const cursor = await session.listMergeRequests();
    // Nothing is authorized or advertised until a page is fetched.
    expect(queue.events).toEqual([]);
    await cursor.next();
    expect(queue.events[0]).toBe("authorize List merge requests");
    expect(queue.events.slice(1).toSorted()).toEqual([`advertise ${oid(1)}`, `advertise ${oid(2)}`]);
    await drain(cursor);
    // oid(3) is a queued push's head: withheld. oid(2) not re-advertised. The second page is
    // authorized as it leaves, under its own title; the closing null after it is not.
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    expect(queue.events.slice(3)).toEqual(["authorize List merge requests (page 2)"]);
    expect(queue.observations).toEqual(["List merge requests", "List merge requests (page 2)"]);
    expect(queue.subresources).toEqual([[BOUND], [BOUND]]);
  });

  it("advertises searchMergeRequests results the same way", async () => {
    const queue = new TestApprovalQueue();
    const session = projectSession(queue, {
      searchMergeRequests: async () => pagesCursor([[mrSummary(1, oid(1), oid(2)), mrSummary(2, oid(3), oid(2))]]),
      isSimulatedCommitId: (id: string) => id === oid(3),
    });
    await drain(await session.searchMergeRequests({ text: "fix" }));
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
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
    // Refs and history are code-only reads, reported by the repository.
    expect(queue.subresources).toEqual([[REPOSITORY], [REPOSITORY], [REPOSITORY]]);
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
    // A commit's details carry CI, so getCommit reports the project; resolveRef only the repository.
    expect(queue.subresources).toEqual([[BOUND], [REPOSITORY], [BOUND], [REPOSITORY]]);
  });

  it("records no observation for its internal branch-head read and declares pushedCommits", async () => {
    const queue = new TestApprovalQueue();
    const submitted: Array<{ action: unknown; presentation: object }> = [];
    const session = projectSession(queue, {
      preparePush: async () => ({ type: "push", approvalId: 1, submittedAt: 0, projectPath: "group/project", branch: "main", expectedOldSha: oid(1), newSha: oid(2), force: false }),
      submitActionForApproval: async (_q: unknown, action: unknown, presentation: object) => { submitted.push({ action, presentation }); },
    });
    await session.push("main", oid(2));
    expect(queue.observations).toEqual([]);
    // The session supplies only the title and flags; the gatekeeper renders the description.
    expect(submitted[0]).toMatchObject({
      presentation: { title: `Push ${oid(2).slice(0, 12)} to main`, pushedCommits: [oid(2)], implementsRevert: true },
    });
    expect(submitted[0].presentation).not.toHaveProperty("description");
    await expect(session.push("main", "abc123")).rejects.toThrow(/full 40-character commit id/);
    await expect(session.push("bad..name", oid(2))).rejects.toThrow();
  });
});

/** Facet KV over a Map, as CodeCaches uses it. */
function memoryKv() {
  const entries = new Map<string, unknown>();
  return {
    get: <T>(key: string) => entries.get(key) as T | undefined,
    put: <T>(key: string, value: T) => { entries.set(key, value); },
    delete: (key: string) => { entries.delete(key); },
    list: <T>({ prefix }: { prefix: string }) =>
      [...entries].filter(([key]) => key.startsWith(prefix)).toSorted(([a], [b]) => a < b ? -1 : 1) as [string, T][],
  };
}

/** A gatekeeper whose codeTarget reads `api` as the bound project, id 1 at `group/project`. */
function codeGatekeeper(api: Partial<GitLabApi>): Partial<Record<string, unknown>> {
  const context: CodeReadContext = {
    read: fn => fn(api as GitLabApi), caches: new CodeCaches(memoryKv()),
    instanceUrl: "https://gitlab.example.com", host: "gitlab.example.com",
  };
  return {
    codeTarget: async () => ({ context, projectId: 1, projectPath: "group/project", defaultBranch: "main" }),
    projectMetadata: async () => ({ path: "group/project" }),
    metadataSubresource: async () => REPOSITORY,
  };
}

describe("GitLabProjectSessionImpl code reads", () => {
  it("reports the repository for metadata, files, listings and code search, advertising only a file's commit", async () => {
    const queue = new TestApprovalQueue();
    const session = projectSession(queue, codeGatekeeper({
      getRepositoryFile: async () => ({ commitId: oid(7), size: 4, content: new TextEncoder().encode("a\nb\n") }),
      listRepositoryTree: async () => ({ items: [{ path: "a", type: "file" }], nextPage: null }),
      searchBlobs: async () => ({
        items: [{ project_id: 1, path: "a", ref: "main", startline: 1, data: "a" }],
        nextPage: null, searchType: "zoekt",
      }),
      graphql: async <T>() => ({
        projects: {
          nodes: [{ id: "gid://gitlab/Project/1", fullPath: "group/project", name: "project",
            webUrl: "https://gitlab.example.com/group/project", visibility: "private", archived: false,
            repository: { rootRef: "main" } }],
          pageInfo: { hasNextPage: false },
        },
      }) as T,
    }));

    await session.getMetadata();
    expect(await session.readFile("a")).toMatchObject({ path: "a", commitId: oid(7), text: "a\nb", totalLines: 2 });
    expect(await drain(await session.listFiles())).toEqual([{ path: "a", type: "file" }]);
    expect(await drain(await session.searchCode({ text: "a" }))).toMatchObject([
      { projectId: 1, projectPath: "group/project", path: "a", matchedAs: "exact" },
    ]);
    expect(queue.observations).toEqual([
      "Read project metadata for group/project", "Read a in group/project", "List files in group/project",
      "Search GitLab code: a in group/project",
    ]);
    expect(queue.subresources).toEqual([[REPOSITORY], [REPOSITORY], [REPOSITORY], [REPOSITORY]]);
    // The file's commit, once its read was authorized; nothing else.
    expect(queue.events.slice(0, 3)).toEqual([
      "authorize Read project metadata for group/project", "authorize Read a in group/project", `advertise ${oid(7)}`,
    ]);
    expect(queue.cache.advertised).toEqual([oid(7)]);
  });
});

describe("GitLabMergeRequestImpl advertising", () => {
  it("advertises the revision shas of readDiff and the merge base, and details' branch shas", async () => {
    const queue = new TestApprovalQueue();
    const session = mrSession(queue, "7", {
      mergeRequestDetails: async () => ({ ...mrSummary(7, oid(1), oid(2)), bodyMarkdown: "", mergeStatus: "mergeable", hasConflicts: false, reviewers: [], approvedBy: [] }),
      mergeRequestDiff: async () => ({ revision: { baseSha: oid(2), headSha: oid(1), mergeBaseSha: oid(3) }, files: pagesCursor([]) }),
      mergeRequestMergeBase: async () => oid(3),
      mergeRequestCommits: async () => pagesCursor([[commitSummary(oid(4), [oid(3)])]]),
    });
    await session.getDetails();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(2)]);
    await session.readDiff();
    expect(queue.cache.advertised.toSorted()).toEqual([oid(1), oid(1), oid(2), oid(2), oid(3)]);
    await session.getMergeBase();
    expect(queue.cache.advertised.filter(id => id === oid(3))).toHaveLength(2);
    await drain(await session.listCommits());
    expect(queue.cache.advertised.filter(id => id === oid(4))).toHaveLength(1);
  });

  it("records no observation for the read that binds a merge's head", async () => {
    const queue = new TestApprovalQueue();
    const submitted: unknown[] = [];
    const session = mrSession(queue, "7", {
      prepareMergeMergeRequest: async (id: string, options: unknown) =>
        ({ type: "mergeMergeRequest", approvalId: 1, submittedAt: 0, projectPath: "group/project", mergeRequestId: id, options, expectedHeadSha: oid(9) }),
      submitActionForApproval: async (_q: unknown, _action: unknown, presentation: unknown) => { submitted.push(presentation); },
    });
    await session.merge({ squash: true });
    expect(queue.observations).toEqual([]);
    expect(submitted).toEqual([{ title: "Merge merge request !7", implementsRevert: false }]);
  });
});

function prepare(type: string) {
  return async () => ({ type });
}

describe("observation logging", () => {
  // Reads a method makes only to prepare an action, or to open a capability, return nothing to
  // the caller, so they must not be logged as observations.
  it("records no observations for mutations or for opening issue and merge request stubs", async () => {
    const queue = new TestApprovalQueue();
    const submitted: string[] = [];
    const session = projectSession(queue, {
      openIssue: async () => ({}),
      openMergeRequest: async () => ({}),
      prepareSetTitle: prepare("setTitle"),
      prepareSetBody: prepare("setBody"),
      prepareAddLabels: prepare("addLabels"),
      prepareRemoveLabels: prepare("removeLabels"),
      prepareChangeState: prepare("changeState"),
      prepareCreateMergeRequest: async () => ({ type: "createMergeRequest", provisionalId: "~1" }),
      submitActionForApproval: async (_queue: unknown, action: { type: string }) => { submitted.push(action.type); },
    });

    for (const item of [await session.getIssue("1"), await session.getMergeRequest("2")]) {
      await item.setTitle("New title");
      await item.setBody("New body");
      await item.addLabels(["bug"]);
      await item.removeLabels(["bug"]);
      await item.close();
      await item.reopen();
    }
    await session.createMergeRequest({ title: "MR", sourceBranch: "feature", targetBranch: "main" });

    expect(submitted).toHaveLength(13);
    expect(queue.observations).toEqual([]);
  });
});
