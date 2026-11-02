// CI reads on the real gatekeeper Durable Object against a fake GitLab: a commit's and a merge
// request's `ci` (the head pipeline, the stale-head rule, the absence policy when there is no
// pipeline and its push-event source, and `ci` left out rather than the read failed when GitLab
// fails a CI read), what a queued push reads as, which pipelines and jobs each binding may open,
// `listJobs()` merging jobs, trigger jobs, and external statuses (retries and status changes
// racing the listings included), failed tests, status read afresh rather than cached, job logs
// (tail, search, a running job, the cache of finished logs and its revalidation against erasure
// and the account's access), the observer gate that log and test-report reads raise to
// Developer (Maintainer for a Maintainer's test report), and those reads refused on a binding an
// earlier version created.

import { env, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitLabJobSummary, GitLabLogPage, GitLabPipelineSummary, GitLabTestCase } from "../../src/types.js";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, stageReconnect, unwrap } from "./fake-gitlab.js";
import type { ActionPresentation, GatekeeperProps, SessionStep } from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = "group%2Fsub%2Fproject";
const PROJECT = "group/sub/project";
/** The bound project's numeric id; pipelines and jobs carrying another ran elsewhere. */
const PROJECT_ID = 1;
const FORK_ID = 2;
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const EARLIER = "c".repeat(40);
const MERGE = "d".repeat(40);
const TARGET = "e".repeat(40);
const PUSHED = "f".repeat(40);
const TREE = "1".repeat(40);
const DESC: ActionPresentation = { title: "push", implementsRevert: true };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function pipeline(id: number, overrides: Record<string, unknown> = {}) {
  return { ...fx.pipelineResponse.data, id, project_id: PROJECT_ID, sha: HEAD, web_url: `https://gitlab.example.com/${PROJECT}/-/pipelines/${id}`, ...overrides };
}

function job(id: number, overrides: Record<string, unknown> = {}) {
  return { ...fx.jobResponse.data, id, web_url: `https://gitlab.example.com/${PROJECT}/-/jobs/${id}`,
    pipeline: { ...fx.jobResponse.data.pipeline, id: 6, project_id: PROJECT_ID }, ...overrides };
}

function trigger(id: number, downstream: { id: number; project_id: number } | null, overrides: Record<string, unknown> = {}) {
  return { ...fx.triggerJobResponse.data, id,
    downstream_pipeline: downstream && { ...fx.triggerJobResponse.data.downstream_pipeline, ...downstream }, ...overrides };
}

function commit(id: string, overrides: Record<string, unknown> = {}) {
  return { ...fx.commitResponse.data, id, parent_ids: [BASE], committed_date: minutesAgo(2), last_pipeline: null, ...overrides };
}

/** A push GitLab recorded `minutes` ago that left a branch at `sha`. */
function pushEvent(sha: string, minutes: number) {
  return { ...fx.pushEventResponse.data, project_id: PROJECT_ID, created_at: minutesAgo(minutes),
    push_data: { ...fx.pushEventResponse.data.push_data, commit_to: sha } };
}

/**
 * GitLab with the project (id 1, default CI config), the owner's and observers' accounts (the
 * bearer token names the user), their memberships (the owner a Maintainer unless `ownerAccess`
 * says otherwise), an instance version that predates `trigger_jobs`, commits served from
 * `commits`, the project's pipelines from `pipelines`, and its push events from `pushEvents`.
 */
class CiFake extends FakeGitLab {
  readonly commits = new Map<string, Record<string, unknown>>();
  readonly branches = new Map<string, string>();
  readonly members = new Map<string, number>();
  /** The connected account's access level on the project; `null` for no membership. */
  ownerAccess: number | null = 40;
  /** Shas at which `.gitlab-ci.yml` exists. */
  readonly ciConfigAt = new Set<string>();
  /** The project's pipelines, newest first; the listing filters them by `sha` as GitLab does. */
  readonly pipelines: Record<string, unknown>[] = [];
  /** The project's push events, newest first; only a listing of pushes is answered. */
  readonly pushEvents: Record<string, unknown>[] = [];
  /** The project's default branch. */
  defaultBranch = "main";

  constructor() {
    super();
    const userId = (name: string) => 100 + [...this.members.keys()].indexOf(name);
    this.on("GET", new RegExp(`^/api/v4/projects/${P}$`), () => json({
      ...fx.projectResponse.data, id: PROJECT_ID, path_with_namespace: PROJECT, web_url: `https://gitlab.example.com/${PROJECT}`,
      namespace: { ...fx.projectResponse.data.namespace, full_path: "group/sub" }, default_branch: this.defaultBranch,
    }));
    this.on("GET", new RegExp(`^/api/v4/projects/${FORK_ID}$`), () => json({
      ...fx.projectResponse.data, id: FORK_ID, name: "fork", path_with_namespace: "someone/fork",
      web_url: "https://gitlab.example.com/someone/fork", namespace: { ...fx.projectResponse.data.namespace, full_path: "someone" },
    }));
    this.on("GET", /^\/api\/v4\/user$/, request => {
      const name = request.headers.get("authorization")!.replace("Bearer ", "");
      return name === "test-token" ? json(fx.currentUserResponse.data)
        : json({ id: userId(name), username: name, name, web_url: `https://gitlab.example.com/${name}` });
    });
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/members/all\\?`), request => {
      const id = Number(request.url.searchParams.get("user_ids[]"));
      if (id === fx.currentUserResponse.data.id) {
        return json(this.ownerAccess === null ? [] : [{ id, username: fx.currentUserResponse.data.username, access_level: this.ownerAccess }]);
      }
      const name = [...this.members.keys()].find(n => userId(n) === id);
      return json(name === undefined ? [] : [{ id, username: name, access_level: this.members.get(name) }]);
    });
    this.on("GET", /^\/api\/v4\/metadata$/, () => json({ version: "17.0.0" }));
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/commits/[^/]+(\\?|$)`), request => {
      const ref = decodeURIComponent(request.url.pathname.split("/repository/commits/")[1]);
      const found = this.commits.get(this.branches.get(ref) ?? ref);
      return found ? json(found) : json({ message: "404 Commit Not Found" }, { status: 404 });
    });
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/branches/`), request => {
      const name = decodeURIComponent(request.url.pathname.split("/repository/branches/")[1]);
      const head = this.branches.get(name);
      return head === undefined ? json({ message: "404 Branch Not Found" }, { status: 404 })
        : json({ name, protected: false, default: name === "main", commit: { id: head } });
    });
    this.on("HEAD", new RegExp(`^/api/v4/projects/${P}/repository/files/\\.gitlab-ci\\.yml\\?`), request =>
      new Response(null, { status: this.ciConfigAt.has(request.url.searchParams.get("ref")!) ? 200 : 404 }));
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines\\?`), request => {
      const sha = request.url.searchParams.get("sha");
      return json(this.pipelines.filter(row => sha === null || row.sha === sha));
    });
    this.on("GET", new RegExp(`^/api/v4/projects/${P}/events\\?(.*&)?action=pushed(&|$)`), () => json(this.pushEvents));
  }

  /** Requests that asked GitLab anything about CI. */
  ciRequests(): string[] {
    return this.requests.map(r => r.url.pathname).filter(path => /pipelines|\/jobs|repository\/files|versions|statuses|\/events/.test(path));
  }
}

let scenario = 0;
async function setup(fake: CiFake, members: Record<string, number> = {}) {
  for (const [name, level] of Object.entries(members)) fake.members.set(name, level);
  fake.install();
  const id = await seedAccount();
  return { props: projectProps(id, PROJECT), name: `ci-${scenario++}` };
}

async function session<T>(name: string, props: GatekeeperProps, ...steps: SessionStep[]): Promise<T> {
  return await unwrap(await hooks().session(name, props, steps)) as T;
}

/** The workspace git cache, holding the commits queued pushes put on GitLab. */
class TestGitCache extends RpcTarget {
  readonly objects = new Map<GitOid, { type: GitObjectType; content: Uint8Array }>();

  withCommit(oid: GitOid, parent: GitOid): this {
    this.objects.set(oid, { type: "commit", content: new TextEncoder().encode([
      `tree ${TREE}`, `parent ${parent}`,
      "author Ada Lovelace <ada@example.com> 1700000000 +0000",
      "committer Ada Lovelace <ada@example.com> 1700000100 +0000", "", "pushed\n",
    ].join("\n")) });
    return this;
  }

  async isAncestor(ancestor: GitOid, descendant: GitOid): Promise<boolean> {
    return ancestor === descendant || this.objects.has(descendant);
  }

  async get(id: GitOid): Promise<{ type: GitObjectType; content: Uint8Array } | null> {
    return this.objects.get(id) ?? null;
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(0)); c.close(); } });
  }
}

function stubOf(cache: TestGitCache): never {
  return new RpcStub(cache) as never;
}

describe("a commit's CI", () => {
  it("reports the commit's newest pipeline", async () => {
    const fake = new CiFake();
    fake.branches.set("main", HEAD);
    fake.commits.set(HEAD, commit(HEAD));
    fake.pipelines.push(pipeline(287, { status: "running" }), pipeline(286, { status: "failed" }), pipeline(9, { sha: BASE }));
    const { props, name } = await setup(fake);
    const { details } = await unwrap(await hooks().getCommit(name, props, "main"));
    expect(details.ci).toMatchObject({ commitId: HEAD, phase: "active", pipeline: { id: "287", status: "running", phase: "active" } });
    expect(details.ci!.pipeline!.project).toBeUndefined();
  });

  it("reads the pipeline afresh each time, reading the commit only once", async () => {
    const fake = new CiFake();
    fake.branches.set("main", HEAD);
    fake.commits.set(HEAD, commit(HEAD));
    const row = pipeline(287, { status: "running" });
    fake.pipelines.push(row);
    const { props, name } = await setup(fake);
    await unwrap(await hooks().getCommit(name, props, "main"));
    row.status = "success";
    expect((await unwrap(await hooks().getCommit(name, props, "main"))).details.ci)
      .toMatchObject({ phase: "done", pipeline: { id: "287", status: "success" } });
    expect(fake.count("GET", /repository\/commits\//)).toBe(1);
  });

  it("still reports a commit's pipeline while a queued push points another branch at it", async () => {
    const fake = new CiFake();
    fake.branches.set("main", HEAD);
    fake.commits.set(HEAD, commit(HEAD));
    fake.pipelines.push(pipeline(290, { status: "failed" }));
    const { props, name } = await setup(fake);
    const cache = new TestGitCache();
    await unwrap(await hooks().queuePush(name, props, ["release", HEAD, false, stubOf(cache)], DESC));
    expect((await unwrap(await hooks().getCommit(name, props, "main", stubOf(cache)))).details.ci)
      .toMatchObject({ commitId: HEAD, phase: "done", pipeline: { id: "290", status: "failed" } });
  });

  it("is notStarted while a configured commit is new, and done once the window has passed", async () => {
    const fake = new CiFake();
    fake.commits.set(HEAD, commit(HEAD, { committed_date: minutesAgo(2) }));
    fake.commits.set(EARLIER, commit(EARLIER, { committed_date: minutesAgo(20) }));
    fake.ciConfigAt.add(HEAD).add(EARLIER);
    const { props, name } = await setup(fake);
    expect((await unwrap(await hooks().getCommit(name, props, HEAD))).details.ci)
      .toEqual({ commitId: HEAD, phase: "notStarted", pipeline: null });
    expect((await unwrap(await hooks().getCommit(name, props, EARLIER))).details.ci)
      .toEqual({ commitId: EARLIER, phase: "done", pipeline: null });
  });

  it("is done at once when no CI is expected, and notStarted when the parent had a pipeline", async () => {
    const fake = new CiFake();
    fake.commits.set(HEAD, commit(HEAD));
    fake.commits.set(BASE, commit(BASE, { parent_ids: [], last_pipeline: null }));
    const { props, name } = await setup(fake);
    expect((await unwrap(await hooks().getCommit(name, props, HEAD))).details.ci)
      .toEqual({ commitId: HEAD, phase: "done", pipeline: null });

    // No `.gitlab-ci.yml` at the commit, but its parent ran a pipeline: CI is expected.
    const other = new CiFake();
    other.commits.set(HEAD, commit(HEAD));
    other.commits.set(BASE, commit(BASE, { parent_ids: [], last_pipeline: pipeline(5, { sha: BASE }) }));
    const second = await setup(other);
    expect((await unwrap(await hooks().getCommit(second.name, second.props, HEAD))).details.ci)
      .toEqual({ commitId: HEAD, phase: "notStarted", pipeline: null });
  });

  it("is omitted when the account may not read the project's pipelines", async () => {
    const fake = new CiFake();
    fake.commits.set(HEAD, commit(HEAD));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines\\?`), () => json({ message: "403 Forbidden" }, { status: 403 }));
    const { props, name } = await setup(fake);
    const { details } = await unwrap(await hooks().getCommit(name, props, HEAD));
    expect(details.id).toBe(HEAD);
    expect(details).not.toHaveProperty("ci");
  });

  it("reads a queued push's commit as notStarted without asking GitLab about CI", async () => {
    const fake = new CiFake();
    fake.branches.set("main", BASE);
    fake.commits.set(BASE, commit(BASE, { parent_ids: [] }));
    const { props, name } = await setup(fake);
    const cache = new TestGitCache().withCommit(PUSHED, BASE);
    await unwrap(await hooks().queuePush(name, props, ["main", PUSHED, false, stubOf(cache)], DESC));

    const { details, fromCache } = await unwrap(await hooks().getCommit(name, props, "main", stubOf(cache)));
    expect(fromCache).toBe(true);
    expect(details.ci).toEqual({ commitId: PUSHED, phase: "notStarted", pipeline: null });
    expect(fake.ciRequests()).toEqual([]);
  });

  it("counts a commit this gatekeeper pushed as a new head, however old the commit is", async () => {
    const fake = new CiFake();
    fake.branches.set("main", BASE);
    fake.commits.set(BASE, commit(BASE, { parent_ids: [] }));
    fake.ciConfigAt.add(PUSHED);
    fake.on("POST", new RegExp(`^/${PROJECT}\\.git/git-receive-pack$`), () => {
      const lines = ["unpack ok", "ok refs/heads/main"].map(encodePktLine);
      return new Response(new Blob([...lines, FLUSH_PKT]), { headers: { "Content-Type": "application/x-git-receive-pack-result" } });
    });
    const { props, name } = await setup(fake);
    const cache = new TestGitCache().withCommit(PUSHED, BASE);
    const action = await unwrap(await hooks().queuePush(name, props, ["main", PUSHED, false, stubOf(cache)], DESC));
    await unwrap(await hooks().applyAction(name, props, action!.approvalId, stubOf(cache)));

    // Authored two days ago, but it became the branch head just now.
    fake.branches.set("main", PUSHED);
    fake.commits.set(PUSHED, commit(PUSHED, { committed_date: minutesAgo(2 * 24 * 60) }));
    expect((await unwrap(await hooks().getCommit(name, props, PUSHED))).details.ci)
      .toEqual({ commitId: PUSHED, phase: "notStarted", pipeline: null });
  });

  describe("an old commit someone else made a head", () => {
    const TWO_DAYS = 2 * 24 * 60;

    function oldFake(): CiFake {
      const fake = new CiFake();
      fake.commits.set(HEAD, commit(HEAD, { committed_date: minutesAgo(TWO_DAYS) }));
      fake.ciConfigAt.add(HEAD);
      return fake;
    }

    it("is notStarted while GitLab's push events say a push left a branch at it a minute ago", async () => {
      const fake = oldFake();
      fake.pushEvents.push(pushEvent(PUSHED, 0.5), pushEvent(HEAD, 1));
      const { props, name } = await setup(fake);
      expect((await unwrap(await hooks().getCommit(name, props, HEAD))).details.ci)
        .toEqual({ commitId: HEAD, phase: "notStarted", pipeline: null });
    });

    it("is done when no push left a branch at it within the window", async () => {
      const fake = oldFake();
      fake.pushEvents.push(pushEvent(PUSHED, 1), pushEvent(HEAD, 30));
      const { props, name } = await setup(fake);
      expect((await unwrap(await hooks().getCommit(name, props, HEAD))).details.ci)
        .toEqual({ commitId: HEAD, phase: "done", pipeline: null });
    });

    it("falls back to the committer date when GitLab fails the push events listing", async () => {
      const fake = oldFake();
      fake.on("GET", new RegExp(`^/api/v4/projects/${P}/events\\?`), () => json({ message: "500 Internal Server Error" }, { status: 500 }));
      const { props, name } = await setup(fake);
      const { details } = await unwrap(await hooks().getCommit(name, props, HEAD));
      expect(details.id).toBe(HEAD);
      expect(details.ci).toEqual({ commitId: HEAD, phase: "done", pipeline: null });
    });

    it("costs no push events read for a new commit, nor for an old one no CI is expected for", async () => {
      const fake = new CiFake();
      fake.commits.set(HEAD, commit(HEAD));
      fake.ciConfigAt.add(HEAD);
      fake.commits.set(EARLIER, commit(EARLIER, { committed_date: minutesAgo(TWO_DAYS) }));
      fake.commits.set(BASE, commit(BASE, { parent_ids: [] }));
      const { props, name } = await setup(fake);
      expect((await unwrap(await hooks().getCommit(name, props, HEAD))).details.ci).toMatchObject({ phase: "notStarted" });
      expect((await unwrap(await hooks().getCommit(name, props, EARLIER))).details.ci).toMatchObject({ phase: "done" });
      expect(fake.count("GET", /\/events\?/)).toBe(0);
    });
  });

  it("is left out, and the commit still returned, when GitLab fails the pipelines listing", async () => {
    const fake = new CiFake();
    fake.commits.set(HEAD, commit(HEAD));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines\\?`), () => json({ message: "500 Internal Server Error" }, { status: 500 }));
    const { props, name } = await setup(fake);
    const { details } = await unwrap(await hooks().getCommit(name, props, HEAD));
    expect(details.id).toBe(HEAD);
    expect(details).not.toHaveProperty("ci");
  });

  it.each([
    ["times out", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["cannot be reached", () => new TypeError("Network connection lost.")],
  ])("is left out, and the commit still returned, when GitLab %s", async (_, failure) => {
    const fake = new CiFake();
    fake.commits.set(HEAD, commit(HEAD));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines\\?`), () => {
      throw failure();
    });
    const { props, name } = await setup(fake);
    const { details } = await unwrap(await hooks().getCommit(name, props, HEAD));
    expect(details.id).toBe(HEAD);
    expect(details).not.toHaveProperty("ci");
  });

  it("still fails the read when the account's credentials are dead", async () => {
    const fake = new CiFake();
    fake.commits.set(HEAD, commit(HEAD));
    fake.on("POST", /^\/oauth\/token/, () => json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }));
    const { props, name } = await setup(fake);
    // The commit read is cached now, so only the CI reads ask GitLab next time.
    await unwrap(await hooks().getCommit(name, props, HEAD));
    expect(await hooks().reportTokenRejected(props.userObjectId, "test-token")).toBe("expired");
    await expect(unwrap(await hooks().getCommit(name, props, HEAD))).rejects.toThrow(/expired or been revoked. Please reconnect/);
  });

  it("reads past the project and commit an earlier version cached in another shape", async () => {
    const fake = new CiFake();
    fake.defaultBranch = "develop";
    fake.branches.set("develop", HEAD);
    fake.commits.set(HEAD, commit(HEAD));
    fake.ciConfigAt.add(HEAD);
    const { props, name } = await setup(fake);
    // That version kept normalised metadata and commit details under these keys.
    const fetchedAt = Date.now();
    await hooks().startOnEarlierStorage(name, props, {
      [`cache:project:${PROJECT}`]: { fetchedAt, generation: 0, value: { path: PROJECT, defaultBranch: "develop" } },
      [`cache:commit:${encodeURIComponent(JSON.stringify("develop"))}`]: { fetchedAt, generation: 0, value: { id: HEAD, parents: [BASE] } },
    });
    const { details } = await unwrap(await hooks().getCommit(name, props, undefined));
    expect(details).toMatchObject({ id: HEAD, parents: [BASE], ci: { commitId: HEAD, phase: "notStarted", pipeline: null } });
  });
});

describe("a merge request's CI", () => {
  const MR = { ...fx.mergeRequestResponse.data, iid: 133, source_branch: "feature", sha: HEAD,
    source_project_id: PROJECT_ID, target_project_id: PROJECT_ID, diff_refs: { base_sha: BASE, start_sha: TARGET, head_sha: HEAD } };

  function mrFake(headPipeline: unknown, overrides: Record<string, unknown> = {}): CiFake {
    const fake = new CiFake();
    const mr = headPipeline === undefined ? { ...MR, ...overrides } : { ...MR, head_pipeline: headPipeline, ...overrides };
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(mr));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json(fx.approvalsResponse.data));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/versions\\?`), () => json([]));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/pipelines\\?`), () => json([]));
    fake.commits.set(HEAD, commit(HEAD, { committed_date: minutesAgo(60) }));
    return fake;
  }

  const details = async (name: string, props: GatekeeperProps) =>
    await unwrap(await hooks().mergeRequestDetails(name, props, "133"));

  it("reports the head pipeline when it ran for the current head", async () => {
    const { props, name } = await setup(mrFake(pipeline(300, { status: "manual" })));
    expect((await details(name, props)).ci).toMatchObject({
      commitId: HEAD, phase: "blocked", pipeline: { id: "300", status: "manual", phase: "blocked" },
    });
  });

  it("counts a merged-results pipeline whose merge commit has the head as a parent", async () => {
    const fake = mrFake(pipeline(301, { sha: MERGE, ref: "refs/merge-requests/133/merge", status: "scheduled" }));
    fake.commits.set(MERGE, commit(MERGE, { parent_ids: [TARGET, HEAD] }));
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toMatchObject({ commitId: HEAD, phase: "active", pipeline: { id: "301", commitId: MERGE } });
  });

  it("counts a merge train pipeline whose train commit has the head as a parent", async () => {
    const fake = mrFake(pipeline(303, { sha: MERGE, ref: "refs/merge-requests/133/train", status: "running" }));
    fake.commits.set(MERGE, commit(MERGE, { parent_ids: [TARGET, HEAD] }));
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toMatchObject({ commitId: HEAD, phase: "active", pipeline: { id: "303", commitId: MERGE } });
  });

  it("reads CI afresh, and follows the head when someone else moves it", async () => {
    const fake = mrFake(undefined);
    let mr: Record<string, unknown> = { ...MR, head_pipeline: pipeline(300, { status: "running" }) };
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () => json(mr));
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toMatchObject({ phase: "active", pipeline: { id: "300", status: "running" } });

    mr = { ...mr, head_pipeline: pipeline(300, { status: "success" }) };
    expect((await details(name, props)).ci).toMatchObject({ phase: "done", pipeline: { id: "300", status: "success" } });

    // A push outside this gatekeeper: the head and its CI move together.
    fake.commits.set(PUSHED, commit(PUSHED));
    mr = { ...mr, sha: PUSHED, diff_refs: { ...MR.diff_refs, head_sha: PUSHED },
      head_pipeline: pipeline(302, { sha: PUSHED, status: "pending" }) };
    const moved = await details(name, props);
    expect(moved.source.sha).toBe(PUSHED);
    expect(moved.ci).toMatchObject({ commitId: PUSHED, phase: "active", pipeline: { id: "302", commitId: PUSHED } });
  });

  it("ignores an earlier head's pipeline and applies the absence policy from the head's diff version", async () => {
    // The head moved a minute ago (its diff version), though the commit is an hour old.
    const fake = mrFake(pipeline(299, { sha: EARLIER }));
    fake.ciConfigAt.add(HEAD);
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/versions\\?`), () => json([
      { id: 2, head_commit_sha: HEAD, created_at: minutesAgo(1) },
      { id: 1, head_commit_sha: EARLIER, created_at: minutesAgo(90) },
    ]));
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toEqual({ commitId: HEAD, phase: "notStarted", pipeline: null });

    // Opening the head's pipeline says to come back, rather than opening the earlier one.
    await expect(session(name, props, { method: "getMergeRequest", args: ["133"] }, { method: "getPipeline" }))
      .rejects.toThrow(/no pipeline yet for the head commit; read again shortly/);
  });

  it("is done with no pipeline once the head has been without one past the window", async () => {
    const fake = mrFake(null);
    fake.ciConfigAt.add(HEAD);
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/versions\\?`), () => json([
      { id: 2, head_commit_sha: HEAD, created_at: minutesAgo(15) },
    ]));
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toEqual({ commitId: HEAD, phase: "done", pipeline: null });
  });

  it("falls back to the commit date, keeping ci, when GitLab fails the diff versions read", async () => {
    const fake = mrFake(null);
    fake.ciConfigAt.add(HEAD);
    fake.commits.set(HEAD, commit(HEAD, { committed_date: minutesAgo(2) }));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/versions\\?`), () =>
      json({ message: "502 Bad Gateway" }, { status: 502 }));
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toEqual({ commitId: HEAD, phase: "notStarted", pipeline: null });
  });

  it("is omitted when GitLab leaves head_pipeline out for an account that may not read pipelines", async () => {
    const { props, name } = await setup(mrFake(undefined));
    const mr = await details(name, props);
    expect(mr.id).toBe("133");
    expect(mr).not.toHaveProperty("ci");
  });

  it("shows a fork's pipeline as data that cannot be opened", async () => {
    const fake = mrFake(pipeline(400, { project_id: FORK_ID }), { source_project_id: FORK_ID });
    const { props, name } = await setup(fake);
    expect((await details(name, props)).ci).toMatchObject({ pipeline: { id: "400", project: { path: "someone/fork" } } });
    await expect(session(name, props, { method: "getMergeRequest", args: ["133"] }, { method: "getPipeline" }))
      .rejects.toThrow(/ran in someone\/fork, another project, so it cannot be opened/);
  });

  it("looks a fork's project up once for a page of its pipelines", async () => {
    // The merge request names its own project, so nothing before the listing looks the fork up.
    const fake = mrFake(undefined);
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/pipelines\\?`), () => json([
      pipeline(403, { project_id: FORK_ID }), pipeline(402, { project_id: FORK_ID }), pipeline(401, { project_id: FORK_ID }), pipeline(6),
    ]));
    const { props, name } = await setup(fake);
    const listed = await session<GitLabPipelineSummary[]>(name, props,
      { method: "getMergeRequest", args: ["133"] }, { method: "listPipelines", args: [], drain: true });
    expect(listed.map(row => row.project?.path ?? null)).toEqual(["someone/fork", "someone/fork", "someone/fork", null]);
    expect(fake.count("GET", new RegExp(`^/api/v4/projects/${FORK_ID}$`))).toBe(1);
  });

  it("reads a head a queued push moved as notStarted without asking GitLab about CI", async () => {
    const fake = mrFake(pipeline(300));
    fake.branches.set("feature", HEAD);
    const { props, name } = await setup(fake);
    const cache = new TestGitCache().withCommit(PUSHED, HEAD);
    await unwrap(await hooks().queuePush(name, props, ["feature", PUSHED, false, stubOf(cache)], DESC));
    expect((await details(name, props)).ci).toEqual({ commitId: PUSHED, phase: "notStarted", pipeline: null });
    expect(fake.ciRequests()).toEqual([]);
    // Opening it says what it waits for.
    await expect(session(name, props, { method: "getMergeRequest", args: ["133"] }, { method: "getPipeline" }))
      .rejects.toThrow(/no pipeline yet for the head commit; it appears after the pushed commits reach GitLab/);
  });
});

describe("what a binding may open", () => {
  function seamFake(): CiFake {
    const fake = new CiFake();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133\\?`), () =>
      json({ ...fx.mergeRequestResponse.data, source_project_id: PROJECT_ID, target_project_id: PROJECT_ID }));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/approvals`), () => json(fx.approvalsResponse.data));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/pipelines\\?`), () => json([
      pipeline(6), pipeline(50, { project_id: FORK_ID }),
    ]));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/(6|5|9)$`), request =>
      json(pipeline(Number(request.url.pathname.split("/").at(-1)))));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/(8|80)$`), request => {
      const id = Number(request.url.pathname.split("/").at(-1));
      return json(job(id, id === 80 ? { pipeline: { ...fx.jobResponse.data.pipeline, id: 9, project_id: PROJECT_ID } } : {}));
    });
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/7$`), () => json({ message: "404 Not found" }, { status: 404 }));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/bridges\\?`), () => json([
      trigger(7, { id: 5, project_id: PROJECT_ID }), trigger(70, { id: 55, project_id: FORK_ID }),
    ]));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/5/bridges\\?`), () => json([]));
    return fake;
  }
  const mr = { method: "getMergeRequest", args: ["133"] };

  it("opens only the merge request's own pipelines, in this project", async () => {
    const { props, name } = await setup(seamFake());
    const opened = await session<{ id: string }>(name, props, mr, { method: "getPipeline", args: ["6"] }, { method: "getDetails" });
    expect(opened.id).toBe("6");
    await expect(session(name, props, mr, { method: "getPipeline", args: ["9"] }))
      .rejects.toThrow("Pipeline 9 is not one of merge request !133's pipelines.");
    await expect(session(name, props, mr, { method: "getPipeline", args: ["50"] }))
      .rejects.toThrow(/ran in another project/);
  });

  it("opens a job only through one of the merge request's pipelines", async () => {
    const { props, name } = await setup(seamFake());
    expect((await session<{ name: string }>(name, props, mr, { method: "getJob", args: ["8"] }, { method: "getDetails" })).name).toBe("rubocop");
    await expect(session(name, props, mr, { method: "getJob", args: ["80"] }))
      .rejects.toThrow("Job 80 does not belong to one of merge request !133's pipelines.");
  });

  it("finds a pipeline or job newer than its cached list of the merge request's pipelines", async () => {
    const fake = seamFake();
    const listed = [pipeline(6)];
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/133/pipelines\\?`), () => json(listed));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6[01]$`), request =>
      json(pipeline(Number(request.url.pathname.split("/").at(-1)))));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/82$`), () =>
      json(job(82, { pipeline: { ...fx.jobResponse.data.pipeline, id: 61, project_id: PROJECT_ID } })));
    const { props, name } = await setup(fake);
    await session(name, props, mr, { method: "getPipeline", args: ["6"] });

    listed.unshift(pipeline(60));
    expect((await session<{ id: string }>(name, props, mr, { method: "getPipeline", args: ["60"] }, { method: "getDetails" })).id)
      .toBe("60");
    listed.unshift(pipeline(61));
    expect((await session<{ id: string }>(name, props, mr, { method: "getJob", args: ["82"] }, { method: "getDetails" })).id)
      .toBe("82");
  });

  it("opens a child pipeline in this project, never a cross-project downstream", async () => {
    const { props, name } = await setup(seamFake());
    const child = await session<{ id: string }>(name, props,
      { method: "getPipeline", args: ["6"] }, { method: "getDownstreamPipeline", args: ["5"] }, { method: "getDetails" });
    expect(child.id).toBe("5");
    await expect(session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDownstreamPipeline", args: ["55"] }))
      .rejects.toThrow("Pipeline 55 ran in another project, so it cannot be opened from this one.");
    await expect(session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDownstreamPipeline", args: ["9"] }))
      .rejects.toThrow("Pipeline 9 was not started by a trigger job of pipeline 6.");
  });

  it("refuses to open a trigger job or an external status as a job", async () => {
    const { props, name } = await setup(seamFake());
    await expect(session(name, props, { method: "getJob", args: ["7"] })).rejects.toThrow(/Only jobs run by a runner/);
    await expect(session(name, props, { method: "getJob", args: ["7x"] })).rejects.toThrow(/positive integer string/);
    // Past 2^53 a number no longer names one job.
    await expect(session(name, props, { method: "getJob", args: ["9007199254740993"] })).rejects.toThrow(/positive integer string/);
  });

  it("records an observation for each read and none for an open", async () => {
    const { props, name } = await setup(seamFake());
    await session(name, props, { method: "getPipeline", args: ["6"] });
    await session(name, props, { method: "getJob", args: ["8"] });
    expect((await hooks().queueLog(name)).observations).toEqual([]);
    await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDetails" });
    expect((await hooks().queueLog(name)).observations).toEqual(["Read pipeline #6"]);
  });
});

describe("listJobs", () => {
  const BUILDS = [job(10, { status: "success", name: "build" }), job(8, { status: "failed" })];
  // GitLab's statuses listing holds the jobs and trigger jobs too, without telling them apart.
  const STATUSES = [
    { id: 8, name: "rubocop", status: "failed", allow_failure: false, created_at: minutesAgo(5), pipeline_id: 6 },
    { id: 7, name: "teaspoon", status: "pending", allow_failure: false, created_at: minutesAgo(5), pipeline_id: 6 },
    { id: 11, name: "ci/lint", status: "failed", description: "3 problems", target_url: "https://lint.example.com/1",
      allow_failure: true, created_at: minutesAgo(4), pipeline_id: 6 },
    { id: 12, name: "other", status: "failed", allow_failure: false, created_at: minutesAgo(4), pipeline_id: 99 },
    { id: 13, name: "unplaced", status: "failed", allow_failure: false, created_at: minutesAgo(4) },
  ];
  const JOBS_ROUTE = new RegExp(`^/api/v4/projects/${P}/pipelines/6/jobs\\?`);
  const STATUSES_ROUTE = new RegExp(`^/api/v4/projects/${P}/repository/commits/${HEAD}/statuses\\?`);
  const scoped = <T extends { status: string }>(request: { url: URL }, rows: T[]) => {
    const scope = request.url.searchParams.getAll("scope[]");
    return rows.filter(row => scope.length === 0 || scope.includes(row.status));
  };

  function jobsFake(): CiFake {
    const fake = new CiFake();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6$`), () => json(pipeline(6)));
    fake.on("GET", JOBS_ROUTE, request => json(scoped(request, BUILDS)));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/bridges\\?`), request =>
      json(scoped(request, [trigger(7, { id: 5, project_id: PROJECT_ID })])));
    fake.on("GET", STATUSES_ROUTE, () => json(STATUSES));
    return fake;
  }

  const listJobs = (filter?: unknown): SessionStep[] =>
    [{ method: "getPipeline", args: ["6"] }, { method: "listJobs", args: filter === undefined ? [] : [filter], drain: true }];

  it("merges jobs, trigger jobs, and the pipeline's external statuses in creation order", async () => {
    const { props, name } = await setup(jobsFake());
    const rows = await session<GitLabJobSummary[]>(name, props,
      { method: "getPipeline", args: ["6"] }, { method: "listJobs", args: [], drain: true });
    expect(rows.map(row => [row.id, row.kind, row.status])).toEqual([
      ["7", "trigger", "pending"], ["8", "job", "failed"], ["10", "job", "success"], ["11", "status", "failed"],
    ]);
    expect(rows[0].downstream).toEqual({ crossProject: false, pipelineId: "5" });
    expect(rows[3]).toMatchObject({ stage: "external", description: "3 problems", targetUrl: "https://lint.example.com/1", allowFailure: true });
  });

  it("filters by status itself, keeping external statuses apart from jobs", async () => {
    const fake = jobsFake();
    const { props, name } = await setup(fake);
    const rows = await session<GitLabJobSummary[]>(name, props,
      { method: "getPipeline", args: ["6"] }, { method: "listJobs", args: [{ status: ["failed"] }], drain: true });
    expect(rows.map(row => [row.id, row.kind])).toEqual([["8", "job"], ["11", "status"]]);
    // GitLab's scope[] would hide the jobs it is told apart from statuses by.
    const jobsRequest = fake.requests.find(r => r.url.pathname.endsWith("/pipelines/6/jobs"))!;
    expect(jobsRequest.url.searchParams.getAll("scope[]")).toEqual([]);
    await expect(session(name, props, { method: "getPipeline", args: ["6"] }, { method: "listJobs", args: [{ status: ["broken"] }] }))
      .rejects.toThrow(/GitLabPipelineImpl\.listJobs/);
  });

  it("never takes a job or trigger job retried while it lists for an external status", async () => {
    // The statuses still show failed job 100 and trigger job 90; by the time the job listings
    // answer, retries have replaced them with 101 and 91, and those listings hold latest attempts only.
    const fake = jobsFake();
    fake.on("GET", STATUSES_ROUTE, () => json([...STATUSES,
      { id: 90, name: "deploy", status: "failed", allow_failure: false, created_at: minutesAgo(3), pipeline_id: 6 },
      { id: 100, name: "flaky", status: "failed", allow_failure: false, created_at: minutesAgo(3), pipeline_id: 6 }]));
    fake.on("GET", JOBS_ROUTE, request => json(scoped(request, [...BUILDS, job(101, { status: "running", name: "flaky" })])));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/bridges\\?`), request => json(scoped(request, [
      trigger(7, { id: 5, project_id: PROJECT_ID }), trigger(91, { id: 9, project_id: PROJECT_ID }, { status: "running", name: "deploy" }),
    ])));
    const { props, name } = await setup(fake);
    const rows = await session<GitLabJobSummary[]>(name, props, ...listJobs());
    expect(rows.map(row => [row.id, row.kind])).toEqual([
      ["7", "trigger"], ["8", "job"], ["10", "job"], ["11", "status"], ["91", "trigger"], ["101", "job"],
    ]);
    // Filtered to what the retried attempts were, they are still not taken for statuses.
    expect((await session<GitLabJobSummary[]>(name, props, ...listJobs({ status: ["failed"] }))).map(row => [row.id, row.kind]))
      .toEqual([["8", "job"], ["11", "status"]]);
  });

  it("never takes a job created while it lists for an external status", async () => {
    const fake = jobsFake();
    // Job 14 appears just after the first of the two listings answers, whichever that is.
    let created = false;
    const late = job(14, { status: "pending", name: "late" });
    const answerThenCreate = (rows: () => unknown[]) => () => {
      const response = json(rows());
      created = true;
      return response;
    };
    fake.on("GET", JOBS_ROUTE, answerThenCreate(() => created ? [...BUILDS, late] : BUILDS));
    fake.on("GET", STATUSES_ROUTE, answerThenCreate(() => created
      ? [...STATUSES, { id: 14, name: "late", status: "pending", allow_failure: false, created_at: minutesAgo(0), pipeline_id: 6 }]
      : STATUSES));
    const { props, name } = await setup(fake);
    const rows = await session<GitLabJobSummary[]>(name, props, ...listJobs());
    expect(rows.find(row => row.id === "14")?.kind).toBe("job");
  });

  it("never takes a job whose status left the filter while it lists for an external status", async () => {
    const fake = jobsFake();
    // Job 15 is running when the statuses are listed, and has succeeded by the time the jobs are.
    fake.on("GET", JOBS_ROUTE, request => json(scoped(request, [...BUILDS, job(15, { status: "success", name: "slow" })])));
    fake.on("GET", STATUSES_ROUTE, () => json([...STATUSES,
      { id: 15, name: "slow", status: "running", allow_failure: false, created_at: minutesAgo(3), pipeline_id: 6 }]));
    const { props, name } = await setup(fake);
    expect(await session<GitLabJobSummary[]>(name, props, ...listJobs({ status: ["running"] }))).toEqual([]);
  });
});

describe("test reports", () => {
  it("pages the failed and errored cases, their output cut short", async () => {
    const fake = new CiFake();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6$`), () => json(pipeline(6)));
    const testCase = (status: string, testName: string, output: string | null = null) =>
      ({ ...fx.testReportResponse.data.test_suites[0].test_cases[0], status, name: testName, system_output: output });
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/test_report$`), () => json({
      ...fx.testReportResponse.data,
      test_suites: [
        { ...fx.testReportResponse.data.test_suites[0], name: "unit",
          test_cases: [testCase("success", "ok"), testCase("failed", "a", "x".repeat(10_000)), testCase("failed", "b")] },
        { ...fx.testReportResponse.data.test_suites[0], name: "e2e", test_cases: [testCase("error", "c"), testCase("skipped", "d")] },
      ],
    }));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/test_report_summary$`), () => json(fx.testReportSummaryResponse.data));
    const { props, name } = await setup(fake);
    const cases = await session<GitLabTestCase[]>(name, props,
      { method: "getPipeline", args: ["6"] }, { method: "listFailedTests", args: [{ resultsPerPage: 2 }], drain: true });
    expect(cases.map(c => [c.suite, c.name, c.status])).toEqual([["unit", "a", "failed"], ["unit", "b", "failed"], ["e2e", "c", "error"]]);
    expect(cases[0].output!.length).toBeLessThan(4200);
    expect(await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" }))
      .toEqual({ total: 3363, failed: 0, errored: 0, skipped: 12, suites: [{ name: "test", total: 3363, failed: 0, errored: 0 }] });
  });

  it("points at the totals and the job logs when the whole report is too large to read", async () => {
    const fake = new CiFake();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6$`), () => json(pipeline(6)));
    // Larger than the client reads (10 MiB), produced a megabyte at a time until it is cut off.
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/test_report$`), () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20)); },
    }), { headers: { "content-type": "application/json" } }));
    const { props, name } = await setup(fake);
    await expect(session(name, props, { method: "getPipeline", args: ["6"] }, { method: "listFailedTests" }))
      .rejects.toThrow(/too large to read here\. Use getTestReport\(\) for its totals, and the failing jobs' logs/);
  });
});

describe("status reads", () => {
  it("are never served from a cache", async () => {
    const fake = new CiFake();
    const listed = pipeline(6, { status: "running" });
    fake.pipelines.push(listed);
    let status = "running";
    let total = 1;
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6$`), () => json(pipeline(6, { status })));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8$`), () => json(job(8, { status })));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/test_report_summary$`), () =>
      json({ ...fx.testReportSummaryResponse.data, total: { ...fx.testReportSummaryResponse.data.total, count: total } }));
    const { props, name } = await setup(fake);
    const read = async () => ({
      pipeline: (await session<{ status: string }>(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDetails" })).status,
      job: (await session<{ status: string }>(name, props, { method: "getJob", args: ["8"] }, { method: "getDetails" })).status,
      listed: (await session<{ status: string }[]>(name, props, { method: "listPipelines", args: [], drain: true }))[0].status,
      tests: (await session<{ total: number }>(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" })).total,
    });
    expect(await read()).toEqual({ pipeline: "running", job: "running", listed: "running", tests: 1 });
    status = listed.status = "success";
    total = 2;
    expect(await read()).toEqual({ pipeline: "success", job: "success", listed: "success", tests: 2 });
  });
});

describe("job logs", () => {
  /** A GitLab-flavoured log: an ANSI-coloured section header, `lines` numbered lines, and a section end. */
  function trace(lines: number): string {
    const body = Array.from({ length: lines }, (_, i) => `line ${i + 1}${(i + 1) % 50 === 0 ? " ERROR here" : ""}`);
    return [`section_start:1700000000:build\r\x1b[0K\x1b[36;1mBuilding\x1b[0;m`, ...body, "section_end:1700000001:build\r\x1b[0K"].join("\n");
  }

  function logFake(status: () => string, erasedAt: () => string | null = () => null): CiFake {
    const fake = new CiFake();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8$`), () => json(job(8, { status: status(), erased_at: erasedAt() })));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8/trace$`), () =>
      new Response(trace(300), { headers: { "content-type": "text/plain" } }));
    return fake;
  }

  const readLog = (options?: unknown) => [{ method: "getJob", args: ["8"] }, { method: "readLog", args: options === undefined ? [] : [options] }];

  it("returns the tail by default, and searches case-insensitively", async () => {
    const { props, name } = await setup(logFake(() => "failed"));
    const tail = await session<GitLabLogPage>(name, props, ...readLog());
    // The section header became line 1, so the 300 body lines are 2-301; the section end is dropped.
    expect(tail).toMatchObject({ totalLines: 301, firstAvailableLine: 1, complete: true });
    expect(tail.lines).toHaveLength(200);
    expect(tail.lines[0]).toEqual({ number: 102, text: "line 101" });
    expect(tail.lines.at(-1)).toEqual({ number: 301, text: "line 300 ERROR here" });

    const head = await session<GitLabLogPage>(name, props, ...readLog({ fromLine: 1, maxLines: 2 }));
    expect(head.lines).toEqual([{ number: 1, text: "▶ Building" }, { number: 2, text: "line 1" }]);

    const found = await session<GitLabLogPage>(name, props, ...readLog({ search: "error", maxLines: 2 }));
    expect(found.lines.map(line => line.text)).toEqual(["line 250 ERROR here", "line 300 ERROR here"]);
    expect((await hooks().queueLog(name)).observations).toContain("Read log of job `rubocop` #8, lines 102–301");
  });

  it("follows a running job's log, reading it afresh each time", async () => {
    const fake = logFake(() => "running");
    const { props, name } = await setup(fake);
    expect((await session<GitLabLogPage>(name, props, ...readLog())).complete).toBe(false);
    await session(name, props, ...readLog());
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(2);
  });

  it("serves a finished log from the cache after rechecking the job, and reports it once erased", async () => {
    let erasedAt: string | null = null;
    const fake = logFake(() => "success", () => erasedAt);
    const { props, name } = await setup(fake);
    await session(name, props, ...readLog());
    await session(name, props, ...readLog({ search: "error" }));
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(1);
    // Each read rechecks the job; the opens share one cached read.
    expect(fake.count("GET", /jobs\/8$/)).toBe(3);

    erasedAt = minutesAgo(1);
    await expect(session(name, props, ...readLog())).rejects.toThrow("The log of job 8 has been erased.");
    // The cached copy went with it: had GitLab kept the log after all, it would be read again.
    erasedAt = null;
    await session(name, props, ...readLog());
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(2);
  });

  it("serves a cached log only while the account may still read debug traces", async () => {
    const fake = logFake(() => "success");
    fake.ownerAccess = 30;
    let traceAllowed = true;
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8/trace$`), () => traceAllowed
      ? new Response(trace(300), { headers: { "content-type": "text/plain" } })
      : json({ message: "403 Forbidden" }, { status: 403 }));
    const { props, name } = await setup(fake);
    await session(name, props, ...readLog());
    await session(name, props, ...readLog());
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(1);

    // Down to Reporter, which still reads the job but not a debug trace: GitLab decides, not the cache.
    fake.ownerAccess = 20;
    traceAllowed = false;
    await expect(session(name, props, ...readLog())).rejects.toThrow(/403|Forbidden/i);
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(2);
    // No longer a member at all: the same.
    fake.ownerAccess = null;
    await expect(session(name, props, ...readLog())).rejects.toThrow(/403|Forbidden/i);
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(3);
  });

  it("refuses bad options before reading anything", async () => {
    const fake = logFake(() => "success");
    const { props, name } = await setup(fake);
    await expect(session(name, props, ...readLog({ maxLines: 0 }))).rejects.toThrow(/maxLines/);
    expect(fake.count("GET", /jobs\/8\/trace$/)).toBe(0);
    // Only the open read the job.
    expect(fake.count("GET", /jobs\/8$/)).toBe(1);
  });
});

describe("observers once logs are read", () => {
  function gateFake(): CiFake {
    const fake = new CiFake();
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8$`), () => json(job(8, { status: "success" })));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/jobs/8/trace$`), () => new Response("hello\n"));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6$`), () => json(pipeline(6)));
    fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/test_report_summary$`), () => json(fx.testReportSummaryResponse.data));
    return fake;
  }

  async function observer(name: string, props: GatekeeperProps, token: string, id = token) {
    return await unwrap(await hooks().addObserver(name, props, await seedAccount({ accessToken: token }), id));
  }

  it("admits a Reporter until a log is read, and only Developers after", async () => {
    const { props, name } = await setup(gateFake(), { reporter: 20, reporter2: 20, developer: 30 });
    await observer(name, props, "reporter");
    await session(name, props, { method: "getJob", args: ["8"] }, { method: "readLog" });
    await expect(observer(name, props, "reporter2")).rejects.toThrow(/Developer role or above/);
    await observer(name, props, "developer");
  });

  it("hides the first log read from a Reporter already observing, and a Maintainer's test report from a Developer", async () => {
    const { props, name } = await setup(gateFake(), { reporter: 20, developer: 30 });
    await observer(name, props, "reporter");
    await observer(name, props, "developer");
    await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDetails" });
    await session(name, props, { method: "getJob", args: ["8"] }, { method: "readLog" });
    await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" });
    const log = await hooks().queueLog(name);
    expect(log.observations).toEqual(["Read pipeline #6", "Read log of job `rubocop` #8, lines 1–1", "Read test report of pipeline #6"]);
    expect(log.excluded).toEqual([undefined, ["reporter"], ["developer", "reporter"]]);
  });

  it("admits only Maintainers once a Maintainer has read a test report", async () => {
    // Through a Maintainer, GitLab includes reports a job restricts to Maintainers.
    const { props, name } = await setup(gateFake(), { developer: 30, maintainer: 40 });
    await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" });
    await expect(observer(name, props, "developer")).rejects.toThrow(/through a Maintainer's connection.*Maintainer role or above/);
    await observer(name, props, "maintainer");
  });

  it("keeps the Developer bar for a test report a Developer read", async () => {
    // GitLab has already left out what a Developer may not download.
    const fake = gateFake();
    fake.ownerAccess = 30;
    const { props, name } = await setup(fake, { reporter: 20, reporter2: 20, developer: 30, developer2: 30 });
    await observer(name, props, "reporter");
    await observer(name, props, "developer");
    await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" });
    expect((await hooks().queueLog(name)).excluded.at(-1)).toEqual(["reporter"]);
    await expect(observer(name, props, "reporter2")).rejects.toThrow(/Developer role or above/);
    await observer(name, props, "developer2");
  });

  it("holds the Maintainer bar for a test report read by an account that is no member", async () => {
    // An instance admin reads every project without a membership row, and downloads what a job
    // restricts to Maintainers; "no row" is not "below Maintainer".
    const fake = gateFake();
    fake.ownerAccess = null;
    const { props, name } = await setup(fake, { developer: 30, maintainer: 40 });
    await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" });
    await expect(observer(name, props, "developer")).rejects.toThrow(/Maintainer role or above/);
    await observer(name, props, "maintainer");
  });

  it.each(["getTestReport", "listFailedTests"] as const)(
    "refuses %s when a reconnect lands mid-read, rather than tracking it at the weaker bar", async method => {
      // The role probe may read the new connection's user (a Developer, say) while the report beside
      // it was fetched with the replaced Maintainer's token.
      const fake = gateFake();
      fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/test_report$`), () => json(fx.testReportResponse.data));
      fake.on("POST", /^\/oauth\/token/, () => json({ access_token: "bob", refresh_token: "bob-refresh", expires_in: 7200 }));
      let reconnected = false;
      fake.on("GET", new RegExp(`^/api/v4/projects/${P}/members/all\\?`), async request => {
        if (Number(request.url.searchParams.get("user_ids[]")) !== fx.currentUserResponse.data.id) return json([]);
        if (!reconnected) {
          reconnected = true;
          // Made here: the handler runs in the gatekeeper's object, not the test's context.
          const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(props.userObjectId));
          await runInDurableObject(account, async instance => {
            await instance.commitReconnect(await stageReconnect(instance, "code-bob"));
          });
        }
        return json([{ id: fx.currentUserResponse.data.id, access_level: 40 }]);
      });
      const { props, name } = await setup(fake);
      await hooks().installCallback(props.userObjectId);
      const read: SessionStep = method === "listFailedTests" ? { method, drain: true } : { method };
      await expect(session(name, props, { method: "getPipeline", args: ["6"] }, read))
        .rejects.toThrow(/GitLab connection changed during this read/);
      expect((await hooks().queueLog(name)).observations).toEqual([]);
      // Under the new connection the read goes through.
      await session(name, props, { method: "getPipeline", args: ["6"] }, read);
    });

  it("shares a binding with up to 50 collaborators", async () => {
    const names = Array.from({ length: 51 }, (_, i) => `member${i}`);
    const { props, name } = await setup(gateFake(), Object.fromEntries(names.map(member => [member, 20])));
    for (const member of names.slice(0, 50)) await observer(name, props, member);
    await expect(observer(name, props, names[50]!)).rejects.toThrow(/already answers for 50 collaborators/);
  });

  describe("on a binding an earlier version created", () => {
    // That version stored no observers, so a Reporter it admitted may still be connected, unknown.
    const REFUSED = "This GitLab connection was created by an earlier version, so job logs and test reports cannot be " +
      "read through it. Remove the GitLab connection and add it again.";

    function legacyFake(): CiFake {
      const fake = gateFake();
      fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/jobs\\?`), () => json([job(8, { status: "success" })]));
      fake.on("GET", new RegExp(`^/api/v4/projects/${P}/pipelines/6/bridges\\?`), () => json([]));
      fake.on("GET", new RegExp(`^/api/v4/projects/${P}/repository/commits/${HEAD}/statuses\\?`), () => json([]));
      return fake;
    }

    it("refuses job logs and test reports before reading them, and serves the other CI reads", async () => {
      const fake = legacyFake();
      const { props, name } = await setup(fake);
      // Keys that version wrote, and no roster marker.
      await hooks().startOnEarlierStorage(name, props, { observerRoster: null, cacheGeneration: 1 });
      await expect(session(name, props, { method: "getJob", args: ["8"] }, { method: "readLog" })).rejects.toThrow(REFUSED);
      await expect(session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" })).rejects.toThrow(REFUSED);
      await expect(session(name, props, { method: "getPipeline", args: ["6"] }, { method: "listFailedTests" })).rejects.toThrow(REFUSED);
      expect(fake.count("GET", /\/trace$|\/test_report/)).toBe(0);

      expect(await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDetails" })).toMatchObject({ id: "6" });
      expect(await session(name, props, { method: "getJob", args: ["8"] }, { method: "getDetails" })).toMatchObject({ id: "8" });
      expect((await session<GitLabJobSummary[]>(name, props, { method: "getPipeline", args: ["6"] }, { method: "listJobs", drain: true }))
        .map(row => row.id)).toEqual(["8"]);
      // Still refused after a restart: the decision is stored, not remade on storage this version wrote.
      await hooks().restart(name);
      await expect(session(name, props, { method: "getJob", args: ["8"] }, { method: "readLog" })).rejects.toThrow(REFUSED);
    });

    it("but a new binding reads them, and still does after a restart", async () => {
      const { props, name } = await setup(legacyFake());
      await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getDetails" });
      await hooks().restart(name);
      expect(await session<GitLabLogPage>(name, props, { method: "getJob", args: ["8"] }, { method: "readLog" }))
        .toMatchObject({ totalLines: 1 });
      expect(await session(name, props, { method: "getPipeline", args: ["6"] }, { method: "getTestReport" })).toMatchObject({ total: 3363 });
    });
  });
});
