// Pull request simulation over queued pushes, driven against the real `GitHubGatekeeperImpl`
// Durable Object (via the TestHooks facet) with GitHub faked at the `fetch` boundary and the
// workspace git cache faked at the `GitCache` stub boundary. The flow under guard is the common
// agent sequence: push a branch (queued), immediately create a pull request against it (queued),
// then keep reading the pull request -- details, diff, commit list -- which must reflect the
// pushed state even though nothing has reached GitHub yet. Also covered: queue-time branch
// validation, the out-of-order-approval guard, and the push-rejection cascade.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionDescription, GitObjectType, GitOid }
  from "@gadgets/workshop-shared/gatekeeper";
import { FLUSH_PKT, encodePktLine } from "../../src/git-transport";
import type { GitHubCommitFilter, GitHubCreatePullRequestOptions } from "../../src/types";
import type {
  CreatePullRequestActionData, GatekeeperProps, Outcome, PushActionData,
} from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const RECEIVE_PACK_URL = `https://github.com/${OWNER}/${REPO}.git/git-receive-pack`;

/** Deterministic fake full oids. */
const BASE = "a".repeat(40);   // main's head, known to GitHub
const HEAD1 = "b".repeat(40);  // the agent-authored commit being pushed
const HEAD2 = "c".repeat(40);  // a second agent-authored commit, child of HEAD1
const OLD = "d".repeat(40);    // an existing PR's remote head, known to GitHub
const TREE_BASE = "1".repeat(40);
const TREE_1 = "2".repeat(40);
const TREE_2 = "6".repeat(40);
const BLOB_HELLO_V1 = "3".repeat(40);
const BLOB_HELLO_V2 = "4".repeat(40);
const BLOB_NEW = "5".repeat(40);
const BLOB_EXTRA = "7".repeat(40);

const encoder = new TextEncoder();

function commitPayload(tree: string, parents: string[], message: string): Uint8Array {
  return encoder.encode([
    `tree ${tree}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Ada Lovelace <ada@example.com> 1700000000 +0000",
    "committer Ada Lovelace <ada@example.com> 1700000100 +0000",
    "",
    `${message}\n`,
  ].join("\n"));
}

function treePayload(entries: { mode: string; name: string; oid: string }[]): Uint8Array {
  const pieces = entries.flatMap(entry => {
    const oidBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      oidBytes[i] = parseInt(entry.oid.slice(i * 2, i * 2 + 2), 16);
    }
    return [encoder.encode(`${entry.mode} ${entry.name}\0`), oidBytes];
  });
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

/**
 * Stands in for the workspace git cache: typed objects (commits, trees, blobs) served for
 * simulation reads, ancestry pairs for the push queue check, and stand-in pack bytes for apply.
 */
class TestGitCache extends RpcTarget {
  readonly objects = new Map<GitOid, { type: GitObjectType, content: Uint8Array }>();
  readonly ancestries = new Set<string>();

  withObject(oid: GitOid, type: GitObjectType, content: Uint8Array): this {
    this.objects.set(oid, { type, content });
    return this;
  }

  withAncestry(ancestor: GitOid, descendant: GitOid): this {
    this.ancestries.add(`${ancestor}:${descendant}`);
    return this;
  }

  async isAncestor(ancestor: GitOid, descendant: GitOid): Promise<boolean> {
    if (!this.objects.has(descendant)) {
      throw new Error(
        `Cannot check ancestry: ${descendant} is not a commit in the workspace's git cache.`);
    }
    return ancestor === descendant || this.ancestries.has(`${ancestor}:${descendant}`);
  }

  async get(id: GitOid): Promise<{ type: GitObjectType, content: Uint8Array } | null> {
    return this.objects.get(id) ?? null;
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("PACK-STAND-IN"));
        controller.close();
      },
    });
  }
}

/** The standard scenario cache: main's history plus the agent commit HEAD1 on top of BASE. */
function scenarioCache(): TestGitCache {
  return new TestGitCache()
    .withObject(BASE, "commit", commitPayload(TREE_BASE, [], "base"))
    .withObject(HEAD1, "commit", commitPayload(TREE_1, [BASE], "feat: add new.txt"))
    .withObject(TREE_BASE, "tree", treePayload([
      { mode: "100644", name: "hello.txt", oid: BLOB_HELLO_V1 },
    ]))
    .withObject(TREE_1, "tree", treePayload([
      { mode: "100644", name: "hello.txt", oid: BLOB_HELLO_V2 },
      { mode: "100644", name: "new.txt", oid: BLOB_NEW },
    ]))
    .withObject(BLOB_HELLO_V1, "blob", encoder.encode("hello\nworld\n"))
    .withObject(BLOB_HELLO_V2, "blob", encoder.encode("hello\nthere\nworld\n"))
    .withObject(BLOB_NEW, "blob", encoder.encode("fresh\n"))
    .withAncestry(BASE, HEAD1);
}

type FakeCommit = { sha: string, message: string, parents?: string[], tree?: string };
type FakeCompare = {
  base_commit: { sha: string },
  /** Omittable to fake a malformed response: GitHub documents it as always present. */
  merge_base_commit?: { sha: string },
  commits: FakeCommit[],
  total_commits: number,
  files: unknown[],
};

function commitResponse(commit: FakeCommit) {
  return {
    sha: commit.sha,
    html_url: `https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`,
    commit: {
      message: commit.message,
      author: null,
      committer: null,
      tree: commit.tree === undefined ? undefined : { sha: commit.tree },
    },
    author: null,
    parents: (commit.parents ?? []).map(sha => ({ sha })),
  };
}

function pullResponse(number: number, head: { ref: string, sha: string }, base: { ref: string, sha: string }) {
  return {
    number,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    state: "open",
    body: "",
    user: null,
    labels: [],
    assignees: [],
    requested_reviewers: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    comments: 0,
    draft: false,
    merged_at: null,
    mergeable: null,
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    head: { ref: head.ref, sha: head.sha, repo: null },
    base: { ref: base.ref, sha: base.sha, repo: null },
  };
}

/**
 * Fakes GitHub at the fetch boundary: branches, single commits (404 for pending ids -- the
 * anchor probe), commit listings, compares, the pulls API (create fails 422 while the head
 * branch is missing, exactly like GitHub), the viewer, and git-receive-pack.
 */
class FakeGitHub {
  readonly branches = new Map<string, string>();
  readonly restCommits = new Map<string, FakeCommit>();
  readonly compares = new Map<string, FakeCompare>();
  readonly commitListings = new Map<string, FakeCommit[]>();  // sha → listing (no path filter)
  readonly pulls = new Map<number, ReturnType<typeof pullResponse>>();
  readonly receivePackResponses: Uint8Array[] = [];
  #nextPullNumber = 7;

  install(): void {
    vi.stubGlobal("fetch", this.#handle.bind(this));
  }

  respondToPush(...lines: string[]): void {
    const pieces = [...lines.map(encodePktLine), FLUSH_PKT];
    const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
    let offset = 0;
    for (const piece of pieces) {
      out.set(piece, offset);
      offset += piece.byteLength;
    }
    this.receivePackResponses.push(out);
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : (input as Request).url ?? String(input));
    const path = url.origin + url.pathname;

    if (path === RECEIVE_PACK_URL) {
      const response = this.receivePackResponses.shift();
      if (!response) throw new Error("test: unexpected receive-pack request");
      return new Response(response, {
        headers: { "Content-Type": "application/x-git-receive-pack-result" },
      });
    }

    if (path === "https://api.github.com/user") {
      return Response.json({
        login: "ada", name: "Ada Lovelace",
        html_url: "https://github.com/ada", avatar_url: "https://github.com/ada.png",
      });
    }

    if (path === API_BASE) {
      // Repo metadata: what resolves an omitted ref to the default branch.
      return Response.json({
        description: null, visibility: "public", private: false, default_branch: "main",
      });
    }

    if (path.startsWith(`${API_BASE}/branches/`)) {
      const name = decodeURIComponent(path.slice(`${API_BASE}/branches/`.length));
      const head = this.branches.get(name);
      if (head === undefined) {
        return Response.json({ message: "Branch not found" }, { status: 404 });
      }
      return Response.json({ name, commit: { sha: head } });
    }

    if (path.startsWith(`${API_BASE}/compare/`)) {
      const basehead = decodeURIComponent(path.slice(`${API_BASE}/compare/`.length));
      const compare = this.compares.get(basehead);
      if (compare === undefined) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ ...compare, commits: compare.commits.map(commitResponse) });
    }

    if (path === `${API_BASE}/commits`) {
      if (url.searchParams.get("path") !== null) return Response.json([]);
      const listing = this.commitListings.get(url.searchParams.get("sha") ?? "") ?? [];
      return Response.json(listing.map(commitResponse));
    }

    if (path.startsWith(`${API_BASE}/commits/`)) {
      const ref = decodeURIComponent(path.slice(`${API_BASE}/commits/`.length));
      const commit = this.restCommits.get(ref);
      if (commit === undefined) {
        // Like GitHub: an unknown full commit id answers 422 ("No commit found for SHA"); only
        // an unknown branch/tag name answers 404. The pending-chain anchor probe
        // (#isCommitOnGitHub) always asks by full id, so it sees the 422 shape here.
        if (/^[0-9a-f]{40}$/.test(ref)) {
          return Response.json({ message: `No commit found for SHA: ${ref}` }, { status: 422 });
        }
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json(commitResponse(commit));
    }

    if (path === `${API_BASE}/pulls` && init?.method === "POST") {
      const body = JSON.parse(await new Response(init.body as BodyInit).text()) as
        { head: string, base: string };
      const headSha = this.branches.get(body.head);
      const baseSha = this.branches.get(body.base);
      if (headSha === undefined || baseSha === undefined) {
        return Response.json({ message: "Validation Failed" }, { status: 422 });
      }
      const number = this.#nextPullNumber++;
      this.pulls.set(number, pullResponse(
        number, { ref: body.head, sha: headSha }, { ref: body.base, sha: baseSha }));
      return Response.json({ number }, { status: 201 });
    }

    if (path.startsWith(`${API_BASE}/pulls/`)) {
      const rest = path.slice(`${API_BASE}/pulls/`.length);
      if (rest.endsWith("/files")) {
        return this.pulls.has(Number(rest.slice(0, -"/files".length)))
          ? Response.json([])
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      const pull = this.pulls.get(Number(rest));
      if (pull === undefined) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json(pull);
    }

    throw new Error(`test: unexpected fetch to ${url}`);
  }
}

/** Records what the gatekeeper submits, standing in for the overseer's approval queue. */
class TestApprovalQueue extends RpcTarget {
  readonly submitted: { action: number, description: ActionDescription }[] = [];

  async authorizeObservation(): Promise<void> {}

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.submitted.push({ action, description });
  }
}

let nextScenario = 0;

// Fresh stubs per call: a stub passed as an RPC argument is disposed when the call returns.
function stubOf(target: TestGitCache | TestApprovalQueue): never {
  return new RpcStub(target) as never;
}

/** Rethrows a forwarded failure locally (see `Outcome` in worker.ts). */
async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

async function repoGatekeeper() {
  const scenario = `pull-sim-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(),
    resourceKind: "repo",
    owner: OWNER,
    repo: REPO,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return {
    preparePush: (branch: string, commitId: string, cache: TestGitCache) =>
      unwrap(hooks.preparePush(scenario, props, branch, commitId, false, stubOf(cache))),
    submitPush: (queue: TestApprovalQueue, action: PushActionData) =>
      unwrap(hooks.submitPush(scenario, props, stubOf(queue), action, {
        title: "push", description: "test push",
        pushedCommits: [action.newSha], implementsRevert: true,
      })),
    prepareCreatePullRequest: (options: GitHubCreatePullRequestOptions) =>
      unwrap(hooks.prepareCreatePullRequest(scenario, props, options)),
    submitCreatePullRequest: (queue: TestApprovalQueue, action: CreatePullRequestActionData) =>
      unwrap(hooks.submitCreatePullRequest(scenario, props, stubOf(queue), action, {
        title: "create PR", description: "test PR", implementsRevert: false,
      })),
    applyAction: (actionId: number, cache: TestGitCache) =>
      unwrap(hooks.applyAction(scenario, props, actionId, stubOf(cache))),
    rejectAction: (actionId: number) => unwrap(hooks.rejectAction(scenario, props, actionId)),
    openPullRequest: (id: string, cache?: TestGitCache) =>
      unwrap(hooks.openPullRequest(scenario, props, id, cache === undefined ? undefined : stubOf(cache))),
    pullDiffAll: (id: string, cache?: TestGitCache) =>
      unwrap(hooks.pullDiffAll(scenario, props, id, cache === undefined ? undefined : stubOf(cache))),
    pullCommitsAll: (id: string, cache?: TestGitCache) =>
      unwrap(hooks.pullCommitsAll(scenario, props, id, cache === undefined ? undefined : stubOf(cache))),
    listCommitsFirstPage: (filter: GitHubCommitFilter | undefined, cache?: TestGitCache) =>
      unwrap(hooks.listCommitsFirstPage(
        scenario, props, filter, 50, cache === undefined ? undefined : stubOf(cache))),
    pullMergeBase: (id: string, cache?: TestGitCache) =>
      unwrap(hooks.pullMergeBase(scenario, props, id, cache === undefined ? undefined : stubOf(cache))),
  };
}

type GatekeeperHandle = Awaited<ReturnType<typeof repoGatekeeper>>;

async function queuePush(
  gk: GatekeeperHandle, cache: TestGitCache, branch: string, commitId: string,
): Promise<PushActionData> {
  const action = await gk.preparePush(branch, commitId, cache);
  if (action === null) throw new Error("test: expected a push action to queue");
  await gk.submitPush(new TestApprovalQueue(), action);
  return action;
}

async function queuePullRequest(
  gk: GatekeeperHandle, options: GitHubCreatePullRequestOptions,
): Promise<CreatePullRequestActionData> {
  const action = await gk.prepareCreatePullRequest(options);
  await gk.submitCreatePullRequest(new TestApprovalQueue(), action);
  return action;
}

/** The standard fake: `main` at BASE (known), agent commits not on GitHub yet. */
function scenarioGitHub(): FakeGitHub {
  const github = new FakeGitHub();
  github.branches.set("main", BASE);
  github.restCommits.set(BASE, { sha: BASE, message: "base", tree: TREE_BASE });
  github.compares.set(`main...${BASE}`, {
    base_commit: { sha: BASE },
    merge_base_commit: { sha: BASE },
    commits: [],
    total_commits: 0,
    files: [],
  });
  github.install();
  return github;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provisional pull request over a queued branch-creation push", () => {
  it("reads details, diff, and commits as if the push had landed", async () => {
    scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    await queuePush(gk, cache, "feature", HEAD1);
    const pr = await queuePullRequest(gk, { title: "Add new.txt", head: "feature", base: "main" });

    const details = await gk.openPullRequest(pr.provisionalId, cache);
    expect(details.id).toBe(pr.provisionalId);
    expect(details.head).toMatchObject({ ref: "feature", sha: HEAD1 });
    expect(details.base).toMatchObject({ ref: "main", sha: BASE });
    expect(details.commits).toBe(1);
    expect(details.additions).toBe(2);   // "there" in hello.txt + "fresh" in new.txt
    expect(details.deletions).toBe(0);
    expect(details.changedFiles).toBe(2);

    const diff = await gk.pullDiffAll(pr.provisionalId, cache);
    expect(diff.revision).toEqual({ baseSha: BASE, headSha: HEAD1, mergeBaseSha: BASE });
    expect(diff.files.map(file => [file.path, file.status, file.diffOmitted]))
      .toEqual([["hello.txt", "modified", false], ["new.txt", "added", false]]);
    expect(diff.files[0].hunks[0].lines)
      .toContainEqual({ kind: "added", text: "there", newLineNumber: 2 });
    expect(diff.files[1].hunks[0].header).toBe("@@ -0,0 +1 @@");

    const commits = await gk.pullCommitsAll(pr.provisionalId, cache);
    expect(commits.map(commit => commit.id)).toEqual([HEAD1]);
    expect(commits[0].message).toBe("feat: add new.txt");
    expect(commits[0].parents).toEqual([BASE]);

    // The merge base comes from the simulated comparison, without fetching any diff.
    expect(await gk.pullMergeBase(pr.provisionalId, cache)).toBe(BASE);
  });

  it("walks stacked queued pushes down to the GitHub-known anchor", async () => {
    // Two stacked pushes to the same new branch: the second one's expectedOldSha is HEAD1 -- a
    // *pending* commit, not a GitHub-known one -- so the anchor walk must continue through it
    // down to BASE rather than asking GitHub to compare against an unpushed commit.
    scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache()
      .withObject(HEAD2, "commit", commitPayload(TREE_2, [HEAD1], "feat: add extra.txt"))
      .withObject(TREE_2, "tree", treePayload([
        { mode: "100644", name: "extra.txt", oid: BLOB_EXTRA },
        { mode: "100644", name: "hello.txt", oid: BLOB_HELLO_V2 },
        { mode: "100644", name: "new.txt", oid: BLOB_NEW },
      ]))
      .withObject(BLOB_EXTRA, "blob", encoder.encode("extra\n"))
      .withAncestry(HEAD1, HEAD2);
    const first = await queuePush(gk, cache, "feature", HEAD1);
    const second = await queuePush(gk, cache, "feature", HEAD2);
    expect(first.expectedOldSha).toBe("0".repeat(40));
    expect(second.expectedOldSha).toBe(HEAD1);
    const pr = await queuePullRequest(gk, { title: "Stacked", head: "feature", base: "main" });

    const details = await gk.openPullRequest(pr.provisionalId, cache);
    expect(details.head.sha).toBe(HEAD2);
    expect(details.commits).toBe(2);
    expect(details.changedFiles).toBe(3);
    expect(details.additions).toBe(3);  // "there", "fresh", and "extra"

    const commits = await gk.pullCommitsAll(pr.provisionalId, cache);
    expect(commits.map(commit => commit.id)).toEqual([HEAD1, HEAD2]);

    const diff = await gk.pullDiffAll(pr.provisionalId, cache);
    expect(diff.revision).toEqual({ baseSha: BASE, headSha: HEAD2, mergeBaseSha: BASE });
    expect(diff.files.map(file => [file.path, file.status]))
      .toEqual([["extra.txt", "added"], ["hello.txt", "modified"], ["new.txt", "added"]]);
  });

  it("falls back to GitHub's compare once the push has been applied", async () => {
    const github = scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    const push = await queuePush(gk, cache, "feature", HEAD1);
    const pr = await queuePullRequest(gk, { title: "Add new.txt", head: "feature", base: "main" });

    github.respondToPush("unpack ok", "ok refs/heads/feature");
    await gk.applyAction(push.approvalId, cache);
    github.branches.set("feature", HEAD1);
    github.restCommits.set(HEAD1, { sha: HEAD1, message: "feat: add new.txt", parents: [BASE] });
    github.compares.set("main...feature", {
      base_commit: { sha: BASE },
      merge_base_commit: { sha: BASE },
      commits: [{ sha: HEAD1, message: "feat: add new.txt", parents: [BASE] }],
      total_commits: 1,
      files: [],
    });

    // No queued pushes remain for the branch, so the provisional read is GitHub's own compare.
    const details = await gk.openPullRequest(pr.provisionalId, cache);
    expect(details.head.sha).toBe(HEAD1);
    expect(details.commits).toBe(1);
    const commits = await gk.pullCommitsAll(pr.provisionalId, cache);
    expect(commits.map(commit => commit.id)).toEqual([HEAD1]);
  });
});

describe("queue-time validation", () => {
  it("rejects a pull request whose head or base branch does not exist, really or simulated", async () => {
    scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache();

    await expect(gk.prepareCreatePullRequest({ title: "x", head: "nope", base: "main" }))
      .rejects.toThrow(/branch does not exist .*Push your commits/s);
    await expect(gk.prepareCreatePullRequest({ title: "x", head: "main", base: "missing" }))
      .rejects.toThrow(/base branch does not exist/);

    // A branch that exists only as a queued push passes.
    await queuePush(gk, cache, "feature", HEAD1);
    const action = await gk.prepareCreatePullRequest({ title: "x", head: "feature", base: "main" });
    expect(action.type).toBe("createPullRequest");
  });
});

describe("approval ordering", () => {
  it("fails an out-of-order apply with guidance, and succeeds once the push lands", async () => {
    const github = scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    const push = await queuePush(gk, cache, "feature", HEAD1);
    const pr = await queuePullRequest(gk, { title: "Add new.txt", head: "feature", base: "main" });

    // The PR create is applied first: GitHub 422s (the branch does not exist), which surfaces
    // as ordering guidance; the action stays pending.
    await expect(gk.applyAction(pr.approvalId, cache))
      .rejects.toThrow(/Approve the push to "feature" first/);

    github.respondToPush("unpack ok", "ok refs/heads/feature");
    await gk.applyAction(push.approvalId, cache);
    github.branches.set("feature", HEAD1);

    await gk.applyAction(pr.approvalId, cache);
    const details = await gk.openPullRequest(pr.provisionalId, cache);
    expect(details.id).toBe("7");  // resolved to the real GitHub number
    expect(details.head.sha).toBe(HEAD1);
  });
});

describe("push rejection cascade", () => {
  it("rejects a dependent pull request whose head branch will no longer exist", async () => {
    scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    const push = await queuePush(gk, cache, "feature", HEAD1);
    const pr = await queuePullRequest(gk, { title: "Add new.txt", head: "feature", base: "main" });

    expect(await gk.rejectAction(push.approvalId)).toEqual({ restart: true });
    await expect(gk.openPullRequest(pr.provisionalId, cache))
      .rejects.toThrow(/No provisional pull request exists/);
    await expect(gk.applyAction(pr.approvalId, cache)).rejects.toThrow(/no longer pending/);
  });

  it("leaves a pull request whose branches still exist", async () => {
    const github = scenarioGitHub();
    github.branches.set("other", OLD);
    github.restCommits.set(OLD, { sha: OLD, message: "old" });
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    const push = await queuePush(gk, cache, "feature", HEAD1);
    const pr = await queuePullRequest(gk, { title: "x", head: "other", base: "main" });

    expect(await gk.rejectAction(push.approvalId)).toBeUndefined();
    // Still pending: applying it now creates the pull request (both branches exist).
    await gk.applyAction(pr.approvalId, cache);
    expect((await gk.openPullRequest(pr.provisionalId, cache)).id).toBe("7");
  });
});

describe("existing pull request with queued head pushes", () => {
  it("reads details, diff, and commits at the simulated head", async () => {
    const github = scenarioGitHub();
    github.branches.set("topic", OLD);
    github.restCommits.set(OLD, { sha: OLD, message: "old head", parents: [BASE], tree: TREE_BASE });
    github.pulls.set(7, pullResponse(7, { ref: "topic", sha: OLD }, { ref: "main", sha: BASE }));
    github.compares.set(`main...${OLD}`, {
      base_commit: { sha: BASE },
      merge_base_commit: { sha: BASE },
      commits: [{ sha: OLD, message: "old head", parents: [BASE] }],
      total_commits: 1,
      files: [],
    });

    const gk = await repoGatekeeper();
    // HEAD1 here is authored on top of OLD rather than BASE.
    const cache = scenarioCache()
      .withObject(HEAD1, "commit", commitPayload(TREE_1, [OLD], "feat: add new.txt"))
      .withAncestry(OLD, HEAD1);
    await queuePush(gk, cache, "topic", HEAD1);

    const details = await gk.openPullRequest("7", cache);
    expect(details.head.sha).toBe(HEAD1);
    expect(details.commits).toBe(2);  // OLD (from GitHub's compare) + HEAD1 (pending)
    expect(details.changedFiles).toBe(2);
    expect(details.mergeable).toBeUndefined();

    const diff = await gk.pullDiffAll("7", cache);
    expect(diff.revision).toEqual({ baseSha: BASE, headSha: HEAD1, mergeBaseSha: BASE });
    expect(diff.files.map(file => file.path)).toEqual(["hello.txt", "new.txt"]);

    const commits = await gk.pullCommitsAll("7", cache);
    expect(commits.map(commit => commit.id)).toEqual([OLD, HEAD1]);

    // The merge base too reads at the simulated head's comparison.
    expect(await gk.pullMergeBase("7", cache)).toBe(BASE);
  });
});

describe("pull request merge base without queued pushes", () => {
  const MERGE_BASE = "e".repeat(40);

  /** A real PR (head `topic` at OLD, base `main` at BASE) whose sha compare names MERGE_BASE. */
  function realPullScenario(): FakeGitHub {
    const github = scenarioGitHub();
    github.branches.set("topic", OLD);
    github.pulls.set(8, pullResponse(8, { ref: "topic", sha: OLD }, { ref: "main", sha: BASE }));
    github.compares.set(`${BASE}...${OLD}`, {
      base_commit: { sha: BASE },
      merge_base_commit: { sha: MERGE_BASE },
      commits: [],
      total_commits: 0,
      files: [],
    });
    return github;
  }

  it("answers from one sha compare, then from the immutable pair cache", async () => {
    const github = realPullScenario();
    const gk = await repoGatekeeper();

    expect(await gk.pullMergeBase("8")).toBe(MERGE_BASE);

    // A merge base of two fixed commits is immutable: the recorded answer outlives the compare.
    github.compares.delete(`${BASE}...${OLD}`);
    expect(await gk.pullMergeBase("8")).toBe(MERGE_BASE);
  });

  it("names the merge base in readDiff's revision", async () => {
    realPullScenario();
    const gk = await repoGatekeeper();

    const diff = await gk.pullDiffAll("8");
    expect(diff.revision).toEqual({ baseSha: BASE, headSha: OLD, mergeBaseSha: MERGE_BASE });
  });

  it("fails rather than approximating when GitHub omits the merge base", async () => {
    // The base tip is not the merge base; a compare response without `merge_base_commit`
    // (documented as always present) must not be answered from `base_commit`.
    const github = realPullScenario();
    github.compares.set(`${BASE}...${OLD}`, {
      base_commit: { sha: BASE },
      commits: [],
      total_commits: 0,
      files: [],
    });
    const gk = await repoGatekeeper();

    await expect(gk.pullMergeBase("8")).rejects.toThrow(/did not include a merge base/);
    // readDiff degrades to an absent mergeBaseSha instead of failing the whole diff read.
    const diff = await gk.pullDiffAll("8");
    expect(diff.revision).toEqual({ baseSha: BASE, headSha: OLD });
  });
});

describe("repo commit listing on a provisional branch", () => {
  it("splices the pending chain ahead of the anchor's remote history", async () => {
    const github = scenarioGitHub();
    github.commitListings.set(BASE, [{ sha: BASE, message: "base", parents: [] }]);
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    await queuePush(gk, cache, "feature", HEAD1);

    const page = await gk.listCommitsFirstPage({ ref: "feature" }, cache);
    expect(page?.map(commit => commit.id)).toEqual([HEAD1, BASE]);

    // A path filter applies to the pending chain locally (tree diff against the parent); the
    // fake returns no remote matches, so only the matching pending commit is listed.
    const filtered = await gk.listCommitsFirstPage({ ref: "feature", path: "new.txt" }, cache);
    expect(filtered?.map(commit => commit.id)).toEqual([HEAD1]);
    const none = await gk.listCommitsFirstPage({ ref: "feature", path: "unrelated.txt" }, cache);
    expect(none).toBeNull();
  });

  it("resolves an omitted ref to the default branch before simulating", async () => {
    // A queued push moves the default branch; a parameterless listing (documented as the
    // default branch, like GitHub's own endpoint) must show the pending head just as
    // getCommit()/resolveRef() do, not the stale remote history.
    const github = scenarioGitHub();
    github.commitListings.set(BASE, [{ sha: BASE, message: "base", parents: [] }]);
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    await queuePush(gk, cache, "main", HEAD1);

    const page = await gk.listCommitsFirstPage(undefined, cache);
    expect(page?.map(commit => commit.id)).toEqual([HEAD1, BASE]);
  });

  it("lists the resolved default branch explicitly when the overlay is a no-op", async () => {
    // The queued default-branch push already landed remotely (its expectation is stale), so
    // nothing is injected -- but the remote listing must still name the branch the pending
    // check consulted, so a parameterless listing stays consistent with getCommit() and
    // resolveRef() even if the repo's live default changes concurrently. The fake keys
    // listings by the `sha` parameter, so only an explicit ?sha=main request finds this one.
    const github = scenarioGitHub();
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    await queuePush(gk, cache, "main", HEAD1);
    github.branches.set("main", HEAD1);  // landed out-of-band: the overlay is a no-op
    github.commitListings.set("main", [
      { sha: HEAD1, message: "feat: add new.txt", parents: [BASE] },
      { sha: BASE, message: "base", parents: [] },
    ]);

    const page = await gk.listCommitsFirstPage(undefined, cache);
    expect(page?.map(commit => commit.id)).toEqual([HEAD1, BASE]);
  });

  it("does not simulate a parameterless listing over a push to a non-default branch", async () => {
    const github = scenarioGitHub();
    // A listing with no `sha` parameter is GitHub's default-branch listing.
    github.commitListings.set("", [{ sha: BASE, message: "base", parents: [] }]);
    const gk = await repoGatekeeper();
    const cache = scenarioCache();
    await queuePush(gk, cache, "feature", HEAD1);

    const page = await gk.listCommitsFirstPage(undefined, cache);
    expect(page?.map(commit => commit.id)).toEqual([BASE]);
  });
});
