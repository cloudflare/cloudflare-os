// Collaborator ("observer") verification for GitLab bindings, through the real gatekeeper and
// UserAccount Durable Objects with GitLab faked at `fetch`: what each read reports to the Workshop,
// the CI jobs it disclosed included, how verifyObserverAccess and addObserver answer, and how both
// hold up when the bound project is renamed or transferred, deleted, or its path taken by another
// project.

import type { RpcStub } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import type { GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fx from "../fixtures/gitlab-docs";
import {
  FakeGitLab, WEB, hooks, json, projectProps, seedAccount, stageReconnect, tokenResponse, type FakeRequest,
} from "./fake-gitlab";
import type { GatekeeperProps, SessionStep } from "./worker";

const PATH = "group/sub/project";
const PROJECT_ID = 42;
/** What an ordinary read through the binding reports. */
const PROJECT = `project/${PROJECT_ID}`;
/** What a read of job 8's log reports beside the project. */
const TRACE = `project/${PROJECT_ID}/jobTrace/8`;
/** What a read of the test reports of pipeline 6, which job 66004's report makes up, reports. */
const ARTIFACTS = `project/${PROJECT_ID}/jobArtifacts/66004`;
/** What earlier releases reported for CI data, now read as the project alone. */
const LEGACY_DEVELOPER = `project/${PROJECT_ID}/role/developer`;
const LEGACY_MAINTAINER = `project/${PROJECT_ID}/role/maintainer`;
/** A project that takes the bound one's path once it has left it. */
const OTHER_ID = 43;
const HEAD = "a".repeat(40);
const PULL_OPTIONS = { type: "commit", commitHistory: { kind: "depth", depth: 1 } } as const;
const OWNER_TOKEN = "owner-token";
const MINUTE = 60_000;

/** GitLab's levels, as `members/all` reports them. */
const REPORTER = 20;
const DEVELOPER_LEVEL = 30;
const MAINTAINER_LEVEL = 40;

/** An upload-pack answer carrying a pack of one byte. */
const uploadPackResponse = () => new Blob([
  encodePktLine("packfile"), new Uint8Array([0x30, 0x30, 0x30, 0x36, 1, 0x50]), FLUSH_PKT,
]);

function failedCase(name: string) {
  return { ...fx.testReportResponse.data.test_suites[0].test_cases[0], name, status: "failed" };
}

/**
 * GitLab's REST API as each token's user sees it: the projects that exist, by id, with their path
 * now; each user's effective membership of each; and the bound project's issues and CI.
 */
class ObserverGitLab extends FakeGitLab {
  readonly projects = new Map<number, string>([[PROJECT_ID, PATH]]);
  /** Paths projects have left, with the project each redirects to until another takes the path. */
  readonly formerPaths = new Map<string, number>();
  /** Each token's GitLab user: its id, and its access level on each project it is a member of. */
  readonly users = new Map<string, { id: number; levels: Map<number, number> }>();
  /** What a token's membership reads are answered with instead, as for an outage. */
  readonly refusals = new Map<string, () => Response>();
  /** The status the bound project's path fails with, while set. */
  probeStatus: number | undefined;
  /** The bound project's open issues. */
  issues: number[] = [];
  /** The paths git requests reached. */
  readonly gitRequests: string[] = [];
  /** Runs as a git request reaches GitLab, before it is answered. */
  onGit: (() => void) | undefined;
  /** Jobs that ran with a debug trace, whose log GitLab shows only to Developers and above. */
  readonly debugJobs = new Set<number>();
  /**
   * The level each job's `artifacts:access` requires, for jobs that restrict it. GitLab's job-level
   * `readJobArtifacts` applies it only through the job's archive (see `archivelessJobs`).
   */
  readonly restrictedArtifacts = new Map<number, number>();
  /** Jobs with a test report but no archive, which `readJobArtifacts` treats as public. */
  readonly archivelessJobs = new Set<number>();
  /** Jobs erased, and jobs deleted. */
  readonly erasedJobs = new Set<number>();
  readonly deletedJobs = new Set<number>();
  /** Jobs still running, with no `finished_at`. */
  readonly runningJobs = new Set<number>();
  /** Each pipeline's jobs, retried ones included, and whether each has a test report. */
  readonly pipelineJobs = new Map<number, Array<{ id: number; junit: boolean }>>([[6, [{ id: 66004, junit: true }]]]);
  /** Each pipeline's child pipelines in the project. */
  readonly childPipelines = new Map<number, number[]>();
  /** How GitLab answers a token exchange or refresh. */
  oauth: () => Response = () => json(fx.oauthInvalidGrantResponse.data, { status: 400 });

  constructor() {
    super();
    this.member(OWNER_TOKEN, { [PROJECT_ID]: MAINTAINER_LEVEL, [OTHER_ID]: MAINTAINER_LEVEL });
    this.on("GET", /^\/api\/v4\//, request => this.#rest(request));
    this.on("POST", /^\/api\/graphql$/, request => this.#graphql(request));
    this.on("POST", /\.git\/git-upload-pack$/, request => this.#git(request));
    this.on("POST", /^\/oauth\/token$/, () => this.oauth());
    this.on("POST", /^\/oauth\/revoke$/, () => json({}));
  }

  /** Gives `token` a GitLab user of its own, a member of each project in `levels` at that level. */
  member(token: string, levels: Record<number, number> = {}): void {
    const user = this.users.get(token) ?? { id: 100 + this.users.size, levels: new Map() };
    for (const [id, level] of Object.entries(levels)) user.levels.set(Number(id), level);
    this.users.set(token, user);
  }

  /** The paths `token` asked GitLab's REST API for. */
  requestsWith(token: string): string[] {
    return this.requests.filter(request => tokenOf(request) === token).map(request => request.url.pathname);
  }

  #rest(request: FakeRequest): Response {
    const path = request.url.pathname.slice("/api/v4".length);
    const token = tokenOf(request);
    const user = this.users.get(token);
    const notFound = json({ message: "404 Project Not Found" }, { status: 404 });
    if (path === "/metadata") return json({ version: "19.2.0" });
    if (path === "/user") {
      return user ? json({ id: user.id, username: token, name: token, web_url: `${WEB}/${token}` })
        : json({ message: "401 Unauthorized" }, { status: 401 });
    }
    const addressed = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    if (!addressed) throw new Error(`test: unexpected GET ${path}`);
    const key = decodeURIComponent(addressed[1]);
    const rest = addressed[2] ?? "";
    let id: number | undefined;
    if (/^\d+$/.test(key)) {
      id = this.projects.has(Number(key)) ? Number(key) : undefined;
    } else {
      if (this.probeStatus !== undefined) return json({ message: "Server Error" }, { status: this.probeStatus });
      id = this.#idAt(key);
      // A path a project left redirects to it by id, until another project takes the path.
      const moved = this.formerPaths.get(key);
      if (id === undefined && moved !== undefined && this.projects.has(moved)) {
        return new Response(null, { status: 301, headers: { location: `${WEB}/api/v4/projects/${moved}${rest}` } });
      }
    }
    // GitLab hides a project a user is no member of (all of these are private).
    if (id === undefined || !user?.levels.has(id)) return notFound;
    if (rest === "") return json(this.#project(id));
    if (rest === "/members/all") {
      const refusal = this.refusals.get(token);
      if (refusal) return refusal();
      const asked = Number(request.url.searchParams.get("user_ids[]"));
      const [name, member] = [...this.users].find(([, candidate]) => candidate.id === asked) ?? [];
      const level = member?.levels.get(id);
      return json(level === undefined ? [] : [{ id: asked, username: name, access_level: level }]);
    }
    if (id !== PROJECT_ID) return notFound;
    const job = /^\/jobs\/(\d+)(\/trace)?$/.exec(rest);
    if (job) {
      const jobId = Number(job[1]);
      if (this.deletedJobs.has(jobId)) return json({ message: "404 Not found" }, { status: 404 });
      if (job[2] === undefined) {
        const running = this.runningJobs.has(jobId);
        return json({ ...fx.jobResponse.data, id: jobId, status: running ? "running" : "success",
          finished_at: running ? null : fx.jobResponse.data.finished_at,
          erased_at: this.erasedJobs.has(jobId) ? "2026-01-01T00:00:00Z" : null,
          artifacts: this.archivelessJobs.has(jobId) ? [{ file_type: "junit" }] : [{ file_type: "archive" }, { file_type: "junit" }],
          pipeline: { ...fx.jobResponse.data.pipeline, id: 6, project_id: PROJECT_ID } });
      }
      if (this.debugJobs.has(jobId) && user!.levels.get(id)! < DEVELOPER_LEVEL) {
        return json({ message: "403 Forbidden" }, { status: 403 });
      }
      return this.erasedJobs.has(jobId) ? json({ message: "404 Not found" }, { status: 404 }) : new Response("hello\n");
    }
    const firstPage = (request.url.searchParams.get("page") ?? "1") === "1";
    const listing = /^\/pipelines\/(\d+)\/(jobs|trigger_jobs)$/.exec(rest);
    if (listing) {
      const pipelineId = Number(listing[1]);
      if (!firstPage) return json([]);
      if (listing[2] === "trigger_jobs") {
        return json((this.childPipelines.get(pipelineId) ?? []).map(child => ({ ...fx.jobResponse.data, id: 5000 + child,
          downstream_pipeline: { ...fx.pipelineResponse.data, id: child, project_id: PROJECT_ID } })));
      }
      const retried = request.url.searchParams.get("include_retried") === "true";
      return json((this.pipelineJobs.get(pipelineId) ?? []).filter((_, index) => retried || index === 0).map(row => ({
        ...fx.jobResponse.data, id: row.id, artifacts: row.junit ? [{ file_type: "junit" }] : [],
      })));
    }
    switch (rest) {
      case "/issues": {
        const open = request.url.searchParams.get("state") !== "closed";
        return json(firstPage && open ? this.issues.map(iid => ({
          ...fx.issueResponse.data, iid, id: 1000 + iid, project_id: PROJECT_ID, title: `Issue ${iid}`,
          web_url: `${WEB}/${this.projects.get(PROJECT_ID)}/-/issues/${iid}`,
        })) : []);
      }
      case "/issues/1":
        return json({ ...fx.issueResponse.data, iid: 1, project_id: PROJECT_ID,
          web_url: `${WEB}/${this.projects.get(PROJECT_ID)}/-/issues/1` });
      case "/merge_requests":
        return json(firstPage ? [{ ...fx.mergeRequestResponse.data, iid: 1,
          project_id: PROJECT_ID, source_project_id: PROJECT_ID, target_project_id: PROJECT_ID,
          web_url: `${WEB}/${this.projects.get(PROJECT_ID)}/-/merge_requests/1` }] : []);
      case "/merge_requests/1":
        return json({ ...fx.mergeRequestResponse.data, iid: 1,
          project_id: PROJECT_ID, source_project_id: PROJECT_ID, target_project_id: PROJECT_ID,
          web_url: `${WEB}/${this.projects.get(PROJECT_ID)}/-/merge_requests/1` });
      case "/issues/1/discussions":
        return json(firstPage ? fx.issueDiscussionsResponse.data : []);
      case "/merge_requests/1/discussions":
        return json(firstPage ? [
          fx.diffDiscussionResponse.data,
          { id: "plain", individual_note: true, notes: [fx.issueNotesResponse.data[1]] },
        ] : []);
      case "/pipelines/6":
        return json({ ...fx.pipelineResponse.data, id: 6, project_id: PROJECT_ID, sha: HEAD });
      case "/pipelines/6/test_report_summary":
        return json(fx.testReportSummaryResponse.data);
      case "/pipelines/6/test_report":
        return json({ ...fx.testReportResponse.data, test_suites: [{
          ...fx.testReportResponse.data.test_suites[0], failed_count: 2,
          test_cases: [failedCase("first"), failedCase("second")],
        }] });
      default:
        return notFound;
    }
  }

  /** The one GraphQL query the gatekeeper asks: whether a job's artifacts are readable. */
  #graphql(request: FakeRequest): Response {
    const user = this.users.get(tokenOf(request));
    const { variables } = JSON.parse(request.body!) as { variables: { project: string[]; job: string } };
    const projectId = Number(variables.project[0].replace("gid://gitlab/Project/", ""));
    const jobId = Number(variables.job.replace("gid://gitlab/Ci::Build/", ""));
    const level = user?.levels.get(projectId);
    // GitLab lists only projects the user can see; all of these are private.
    if (level === undefined) return json({ data: { projects: { nodes: [] } } });
    const job = this.deletedJobs.has(jobId) ? null : {
      erasedAt: this.erasedJobs.has(jobId) ? "2026-01-01T00:00:00Z" : null,
      userPermissions: {
        readJobArtifacts: this.archivelessJobs.has(jobId) || level >= (this.restrictedArtifacts.get(jobId) ?? REPORTER),
      },
    };
    return json({ data: { projects: { nodes: [{ job }] } } });
  }

  #git(request: FakeRequest): Response {
    // GitLab serves git by the path a project has now, as it does any project.
    const path = decodeURIComponent(request.url.pathname.replace(/^\/|\.git\/git-upload-pack$/g, ""));
    if (this.#idAt(path) === undefined) return new Response("Not Found", { status: 404 });
    this.gitRequests.push(path);
    this.onGit?.();
    return new Response(uploadPackResponse(), { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
  }

  #idAt(path: string): number | undefined {
    return [...this.projects].find(([, current]) => current === path)?.[0];
  }

  #project(id: number) {
    const path = this.projects.get(id)!;
    return {
      ...fx.projectResponse.data, id, name: path.slice(path.lastIndexOf("/") + 1), path_with_namespace: path,
      web_url: `${WEB}/${path}`, namespace: { ...fx.projectResponse.data.namespace, full_path: path.slice(0, path.lastIndexOf("/")) },
    };
  }
}

function tokenOf(request: FakeRequest): string {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

/** A connected account whose token is `token`. */
const account = (token: string) => seedAccount({ accessToken: token });

let scenarios = 0;

/**
 * A binding of `group/sub/project` by the owner's account; with `pinned`, as an earlier read left
 * it, its project's id already stored.
 */
async function binding(options: { pinned?: boolean; reportsSubresources?: true } = {}) {
  const name = `observers-${++scenarios}`;
  const props: GatekeeperProps = {
    ...projectProps(await account(OWNER_TOKEN), PATH),
    ...(options.reportsSubresources ? { reportsSubresources: true } : {}),
  };
  if (options.pinned) await hooks().startOnEarlierStorage(name, props, { projectId: PROJECT_ID });
  return {
    /** The binding owner's account. */
    owner: props.userObjectId,
    read: (steps: SessionStep[]) => hooks().session(name, props, steps),
    /** Walks the cursor the last step returns, asking once more for a page that fails. */
    pages: (steps: SessionStep[]) => hooks().sessionRetryingPages(name, props, steps),
    /** What each observation so far reported, by title. */
    observations: async () => {
      const log = await hooks().queueLog(name);
      return log.observations.map((title, index) => ({ title, subresources: log.subresources[index] }));
    },
    refuse: (ordinal: number) => hooks().refuseObservation(name, ordinal),
    /** Writes `entries` into the binding's storage, then restarts it, as an upgrade would. */
    upgradeFrom: async (entries: Record<string, unknown>) => {
      await hooks().restart(name);
      await hooks().startOnEarlierStorage(name, props, entries);
    },
    /** gitPull of HEAD; the transfer's status once drained, or the pull's error. */
    pull: async (): Promise<{ ok: unknown } | { error: string }> => {
      const outcome = await hooks().gitPull(name, props, [HEAD], PULL_OPTIONS);
      if ("error" in outcome) return outcome;
      using transfer = outcome.ok as unknown as RpcStub<GitPullTransfer>;
      await new Response(await transfer.stream()).arrayBuffer();
      return { ok: await transfer.status() };
    },
    /** verifyObserverAccess for observers named by id, each with the account given. */
    verify: (observers: Record<string, string>, subresources = [PROJECT]) => hooks().verifyObservers(
      name, props, Object.entries(observers).map(([id, userObjectId]) => ({ id, userObjectId })), subresources),
    admit: (userObjectId: string, observerId?: string) => hooks().addObserver(name, props, userObjectId, observerId),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reads", () => {
  it("report the pinned project by its id, whatever served them", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1, 2];
    gitlab.install();
    const gk = await binding();

    // The first read pins the project's id, by its path, before anything is disclosed.
    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: { path: PATH } });
    // Served from the cache, without asking GitLab again.
    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: { path: PATH } });
    expect(gitlab.requestsWith(OWNER_TOKEN)).toEqual(["/api/v4/projects/group%2Fsub%2Fproject", `/api/v4/projects/${PROJECT_ID}`]);
    // Every page of a listing as it leaves, one served from the buffer of an earlier fetch
    // included; the listing's end, after them, discloses nothing more.
    expect(await gk.read([{ method: "listIssues", args: [{ resultsPerPage: 1 }], drain: true }]))
      .toMatchObject({ ok: [{ id: "1" }, { id: "2" }] });
    // A listing that finds nothing answers too.
    expect(await gk.read([{ method: "listIssues", args: [{ state: "closed" }], drain: true }])).toEqual({ ok: [] });
    // CI that is no more than the project's, through the stub opening a pipeline returns.
    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "getDetails" }]))
      .toMatchObject({ ok: { id: "6" } });

    expect(await gk.observations()).toEqual([
      { title: `Read project metadata for ${PATH}`, subresources: [PROJECT] },
      { title: `Read project metadata for ${PATH}`, subresources: [PROJECT] },
      { title: "List issues", subresources: [PROJECT] },
      { title: "List issues (page 2)", subresources: [PROJECT] },
      { title: "List issues", subresources: [PROJECT] },
      { title: "Read pipeline #6", subresources: [PROJECT] },
    ]);
  });

  it("report the jobs whose log or test reports CI data came from", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const gk = await binding();

    expect(await gk.read([{ method: "getJob", args: ["8"] }, { method: "readLog" }]))
      .toMatchObject({ ok: { lines: [{ number: 1 }] } });
    // Each page of the failed tests, and the summary, name the job the report came from.
    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "listFailedTests", args: [{ resultsPerPage: 1 }], drain: true }]))
      .toMatchObject({ ok: [{ name: "first" }, { name: "second" }] });
    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "getTestReport" }])).toMatchObject({ ok: {} });

    expect(await gk.observations()).toEqual([
      { title: "Read log of job `rubocop` #8, lines 1–1", subresources: [TRACE] },
      { title: "Read failed tests of pipeline #6", subresources: [ARTIFACTS] },
      { title: "Read failed tests of pipeline #6 (page 2)", subresources: [ARTIFACTS] },
      { title: "Read test report of pipeline #6", subresources: [ARTIFACTS] },
    ]);
  });

  it("report the project for a test report that holds no job's reports", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${PROJECT_ID}/pipelines/6/test_report_summary$`), () =>
      json({ ...fx.testReportSummaryResponse.data, test_suites: [] }));
    const gk = await binding();

    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "getTestReport" }])).toMatchObject({ ok: {} });
    expect(await gk.observations()).toEqual([{ title: "Read test report of pipeline #6", subresources: [PROJECT] }]);
  });

  it("report failed tests as from every job with a test report the whole report could hold", async () => {
    // The whole report names no jobs, may be up to two minutes old, and can hold a job the summary
    // does not list yet, so the summary is not asked: retried attempts and same-project child
    // pipelines are listed instead, and jobs without a test report left out.
    const gitlab = new ObserverGitLab();
    gitlab.install();
    gitlab.pipelineJobs.set(6, [{ id: 71, junit: true }, { id: 70, junit: true }, { id: 72, junit: false }]);
    gitlab.childPipelines.set(6, [9]);
    gitlab.pipelineJobs.set(9, [{ id: 90, junit: true }]);
    const gk = await binding();

    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "listFailedTests", drain: true }]))
      .toMatchObject({ ok: [{ name: "first" }, { name: "second" }] });
    const [{ subresources }] = await gk.observations();
    expect(subresources?.toSorted()).toEqual([70, 71, 90].map(jobId => `project/${PROJECT_ID}/jobArtifacts/${jobId}`));
    expect(gitlab.requestsWith(OWNER_TOKEN)).not.toContain(`/api/v4/projects/${PROJECT_ID}/pipelines/6/test_report_summary`);
  });

  it("authorize each page of a listing as it leaves, a refused one ending the listing", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1, 2];
    gitlab.install();
    const gk = await binding({ pinned: true });
    await gk.refuse(2);

    // The second page is refused, and so is the retry; a new listing goes through.
    expect(await gk.pages([{ method: "listIssues", args: [{ resultsPerPage: 1 }] }])).toMatchObject({
      ok: { served: [[{ id: "1" }]], errors: [expect.stringContaining("audience was refused"), expect.stringContaining("audience was refused")] },
    });
    expect(await gk.read([{ method: "listIssues", args: [{ resultsPerPage: 1 }], drain: true }]))
      .toMatchObject({ ok: [{ id: "1" }, { id: "2" }] });
    expect((await gk.observations()).map(observation => observation.title))
      .toEqual(["List issues", "List issues", "List issues (page 2)"]);
  });

  it("follow the project through a rename and a transfer by its id", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1];
    gitlab.install();
    const gk = await binding({ pinned: true });
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    gitlab.formerPaths.set(PATH, PROJECT_ID);

    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: { path: "acme/renamed" } });
    expect(await gk.read([{ method: "listIssues", drain: true }])).toMatchObject({ ok: [{ id: "1" }] });
    expect(gitlab.requestsWith(OWNER_TOKEN).filter(path => !path.startsWith(`/api/v4/projects/${PROJECT_ID}`)))
      .toEqual([]);
    expect((await gk.observations()).map(observation => observation.subresources)).toEqual([[PROJECT], [PROJECT]]);
  });

  it("returns current issue and merge request references when the original path is reused", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1];
    gitlab.install();
    const gk = await binding({ pinned: true });
    const moved = "acme/renamed";
    gitlab.projects.set(PROJECT_ID, moved);
    gitlab.projects.set(OTHER_ID, PATH);
    const project = { path: moved, namespace: "acme", url: `${WEB}/${moved}` };

    expect(await gk.read([{ method: "getIssue", args: ["1"] }, { method: "getDetails" }]))
      .toMatchObject({ ok: { project, url: `${WEB}/${moved}/-/issues/1` } });
    expect(await gk.read([{ method: "listIssues", drain: true }]))
      .toMatchObject({ ok: [{ project, url: `${WEB}/${moved}/-/issues/1` }] });
    const mr = { project, source: { project }, target: { project }, url: `${WEB}/${moved}/-/merge_requests/1` };
    expect(await gk.read([{ method: "getMergeRequest", args: ["1"] }, { method: "getDetails" }]))
      .toMatchObject({ ok: mr });
    expect(await gk.read([{ method: "listMergeRequests", drain: true }])).toMatchObject({ ok: [mr] });
    expect(gitlab.requestsWith(OWNER_TOKEN).filter(path => !path.startsWith(`/api/v4/projects/${PROJECT_ID}`)))
      .toEqual([]);
    expect((await gk.observations()).every(observation => observation.subresources?.[0] === PROJECT)).toBe(true);
  });

  it("links comments and diff threads beneath the project's current path when the original is reused", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const gk = await binding({ pinned: true });
    const moved = "acme/renamed";
    gitlab.projects.set(PROJECT_ID, moved);
    gitlab.projects.set(OTHER_ID, PATH);
    const issue = `${WEB}/${moved}/-/issues/1`;
    const mr = `${WEB}/${moved}/-/merge_requests/1`;

    expect(await gk.read([{ method: "getIssue", args: ["1"] }, { method: "postComment", args: ["Queued"] }]))
      .toEqual({ ok: undefined });
    expect(await gk.read([{ method: "getIssue", args: ["1"] }, { method: "readDiscussion", drain: true }]))
      .toMatchObject({ ok: [
        { url: `${issue}#note_1126` }, { url: `${issue}#note_1128` }, { url: `${issue}#note_1129` },
        { id: "~comment1", url: `${issue}#note_~comment1` },
      ] });
    expect(await gk.read([{ method: "getMergeRequest", args: ["1"] }, { method: "readDiscussion", drain: true }]))
      .toMatchObject({ ok: [{ url: `${mr}#note_305` }] });
    expect(await gk.read([{ method: "getMergeRequest", args: ["1"] }, { method: "readDiffThreads", drain: true }]))
      .toMatchObject({ ok: [{ comments: [{ url: `${mr}#note_1128` }] }] });
    expect(await gk.read([{ method: "createIssue", args: [{ title: "Queued" }] }, { method: "getDetails" }]))
      .toMatchObject({ ok: { project: { path: moved }, url: `${WEB}/${moved}/-/issues/~1` } });
    // The current path is read by the project's id, never through the path another project took.
    expect(gitlab.requestsWith(OWNER_TOKEN).filter(path =>
      path.startsWith("/api/v4/projects/") && !path.startsWith(`/api/v4/projects/${PROJECT_ID}`))).toEqual([]);
  });

  it("disclose nothing once the project is deleted and another takes its path", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1];
    gitlab.install();
    const gk = await binding({ pinned: true });
    gitlab.projects.delete(PROJECT_ID);
    gitlab.projects.set(OTHER_ID, PATH);

    expect(await gk.read([{ method: "getMetadata" }])).toEqual({ error: expect.any(String) });
    expect(await gk.read([{ method: "listIssues", drain: true }])).toEqual({ error: expect.any(String) });
    expect(await gk.read([{ method: "getJob", args: ["8"] }, { method: "readLog" }])).toEqual({ error: expect.any(String) });
    expect(await gk.observations()).toEqual([]);
    // Never asked of the project the path now names, by that path or its id.
    expect(gitlab.requestsWith(OWNER_TOKEN).filter(path => !path.startsWith(`/api/v4/projects/${PROJECT_ID}`)))
      .toEqual([]);
  });

  it("pull git by the path the project's id has now, and serve nothing from a path it left", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const gk = await binding({ pinned: true });
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    expect(await gk.pull()).toEqual({ ok: { state: "complete" } });
    expect(gitlab.gitRequests).toEqual(["acme/renamed"]);

    // Deleted, and its old path taken by another project: the fetch may go to the path it had,
    // from the cached project, but the answer is refused, and the next one asks nothing of it.
    gitlab.projects.delete(PROJECT_ID);
    gitlab.projects.set(OTHER_ID, "acme/renamed");
    expect(await gk.pull()).toEqual({ error: expect.any(String) });
    expect(await gk.pull()).toEqual({ error: expect.any(String) });
    expect(gitlab.gitRequests).toEqual(["acme/renamed", "acme/renamed"]);
  });

  it("refuse a git answer if the project moved before it arrived, and send the retry to its new path", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const gk = await binding({ pinned: true });
    // Moved as the request reaches GitLab: the path it was sent to may name another project.
    gitlab.onGit = () => gitlab.projects.set(PROJECT_ID, "acme/renamed");
    expect(await gk.pull()).toEqual({ error: expect.stringContaining(`was moved from ${PATH}`) });

    gitlab.onGit = undefined;
    expect(await gk.pull()).toEqual({ ok: { state: "complete" } });
    expect(gitlab.gitRequests).toEqual([PATH, "acme/renamed"]);

    // A fetch reads the path once, from the cached project, and checks it once afresh.
    const before = gitlab.requestsWith(OWNER_TOKEN).length;
    expect(await gk.pull()).toEqual({ ok: { state: "complete" } });
    expect(gitlab.requestsWith(OWNER_TOKEN).slice(before))
      .toEqual([`/api/v4/projects/${PROJECT_ID}`]);
  });

  it("serve nothing cached while the project was read by path", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1];
    gitlab.install();
    const gk = await binding({ pinned: true });
    expect(await gk.read([{ method: "listIssues", drain: true }])).toMatchObject({ ok: [{ id: "1" }] });
    gitlab.issues = [2];
    expect(await gk.read([{ method: "listIssues", drain: true }])).toMatchObject({ ok: [{ id: "1" }] });

    // As a release that addressed the project by path left the binding: what it cached may have
    // come from another project that had taken the path.
    await gk.upgradeFrom({ cachesByProjectId: null });
    expect(await gk.read([{ method: "listIssues", drain: true }])).toMatchObject({ ok: [{ id: "2" }] });
  });

  it("disclose nothing until the project's id is pinned, then report it", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.probeStatus = 502;
    gitlab.install();
    const gk = await binding();

    expect(await gk.read([{ method: "getMetadata" }])).toEqual({ error: expect.any(String) });
    expect(await gk.read([{ method: "listIssues", drain: true }])).toEqual({ error: expect.any(String) });
    expect(await gk.observations()).toEqual([]);
    // Nothing was read in the meantime, by path or by any id.
    expect(gitlab.requestsWith(OWNER_TOKEN))
      .toEqual(["/api/v4/projects/group%2Fsub%2Fproject", "/api/v4/projects/group%2Fsub%2Fproject"]);

    gitlab.probeStatus = undefined;
    expect(await gk.read([{ method: "getMetadata" }])).toMatchObject({ ok: {} });
    expect(await gk.observations()).toEqual([{ title: `Read project metadata for ${PATH}`, subresources: [PROJECT] }]);
  });
});

describe("verifyObserverAccess", () => {
  it("allows a member to see a job's log or artifacts unless GitLab withholds that job's from them", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [guest, reporter, developer, maintainer, outsider] = await Promise.all(
      ["guest", "reporter", "developer", "maintainer", "outsider"].map(token => account(token)));
    gitlab.member("guest", { [PROJECT_ID]: 10 });
    gitlab.member("reporter", { [PROJECT_ID]: REPORTER });
    gitlab.member("developer", { [PROJECT_ID]: DEVELOPER_LEVEL });
    gitlab.member("maintainer", { [PROJECT_ID]: MAINTAINER_LEVEL });
    gitlab.member("outsider");
    const gk = await binding();
    const everyone = { guest, reporter, developer, maintainer, outsider };
    const members = ["reporter", "developer", "maintainer"];
    const trace = (jobId: number) => `project/${PROJECT_ID}/jobTrace/${jobId}`;
    const artifacts = (jobId: number) => `project/${PROJECT_ID}/jobArtifacts/${jobId}`;
    gitlab.debugJobs.add(9);
    gitlab.restrictedArtifacts.set(10, DEVELOPER_LEVEL);
    gitlab.restrictedArtifacts.set(11, MAINTAINER_LEVEL);

    expect(await gk.verify(everyone, [PROJECT])).toEqual({ ok: members });
    // An ordinary job's log and artifacts are every member's.
    expect(await gk.verify(everyone, [trace(8), artifacts(8)])).toEqual({ ok: members });
    // A debug trace is a Developer's, and restricted artifacts their role's.
    expect(await gk.verify(everyone, [trace(9)])).toEqual({ ok: ["developer", "maintainer"] });
    expect(await gk.verify(everyone, [artifacts(10)])).toEqual({ ok: ["developer", "maintainer"] });
    expect(await gk.verify(everyone, [artifacts(11)])).toEqual({ ok: ["maintainer"] });
    // Each observer is asked with their own token, membership by the project's id once and first,
    // then its jobs, a few at a time and so in no fixed order.
    const asked = gitlab.requestsWith("reporter");
    expect(asked.slice(0, 2)).toEqual(["/api/v4/user", `/api/v4/projects/${PROJECT_ID}/members/all`]);
    expect(asked.slice(2).toSorted()).toEqual([
      `/api/v4/projects/${PROJECT_ID}/jobs/8`, `/api/v4/projects/${PROJECT_ID}/jobs/8/trace`,
      `/api/v4/projects/${PROJECT_ID}/jobs/8`, "/api/graphql",
      `/api/v4/projects/${PROJECT_ID}/jobs/9`, `/api/v4/projects/${PROJECT_ID}/jobs/9/trace`,
      `/api/v4/projects/${PROJECT_ID}/jobs/10`, "/api/graphql", `/api/v4/projects/${PROJECT_ID}/jobs/11`, "/api/graphql",
    ].toSorted());
    // The binding's own account was never asked.
    expect(gitlab.requestsWith(OWNER_TOKEN)).toEqual([]);
  });

  it("holds a test report from a job with no archive to Maintainer, which GitLab's job check would call public", async () => {
    // `artifacts:access` still restricts such a job's report, but readJobArtifacts follows the
    // archive, so nothing GitLab exposes says how far.
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [reporter, developer, maintainer] = await Promise.all(["reporter", "developer", "maintainer"].map(token => account(token)));
    gitlab.member("reporter", { [PROJECT_ID]: REPORTER });
    gitlab.member("developer", { [PROJECT_ID]: DEVELOPER_LEVEL });
    gitlab.member("maintainer", { [PROJECT_ID]: MAINTAINER_LEVEL });
    gitlab.archivelessJobs.add(12);
    const gk = await binding();

    expect(await gk.verify({ reporter, developer, maintainer }, [`project/${PROJECT_ID}/jobArtifacts/12`]))
      .toEqual({ ok: ["maintainer"] });
    expect(gitlab.requestsWith("reporter")).not.toContain("/api/graphql");
  });

  it("lets any member see an erased or deleted job's, which hold nothing left to withhold", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [reporter, outsider] = await Promise.all([account("reporter"), account("outsider")]);
    gitlab.member("reporter", { [PROJECT_ID]: REPORTER });
    gitlab.member("outsider");
    for (const jobId of [9, 10]) {
      gitlab.debugJobs.add(jobId);
      gitlab.restrictedArtifacts.set(jobId, MAINTAINER_LEVEL);
    }
    gitlab.erasedJobs.add(9);
    gitlab.deletedJobs.add(10);
    const gk = await binding();

    expect(await gk.verify({ reporter, outsider }, [9, 10].flatMap(jobId =>
      [`project/${PROJECT_ID}/jobTrace/${jobId}`, `project/${PROJECT_ID}/jobArtifacts/${jobId}`])))
      .toEqual({ ok: ["reporter"] });
  });

  it("reads the role IDs earlier releases reported as the project alone", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [reporter, outsider] = await Promise.all([account("reporter"), account("outsider")]);
    gitlab.member("reporter", { [PROJECT_ID]: REPORTER });
    gitlab.member("outsider");
    const gk = await binding();

    expect(await gk.verify({ reporter, outsider }, [LEGACY_DEVELOPER, LEGACY_MAINTAINER])).toEqual({ ok: ["reporter"] });
  });

  it("fails, denying no one for good, when an outage keeps GitLab from answering", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, carol] = await Promise.all([account("alice"), account("carol")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("carol", { [PROJECT_ID]: REPORTER });
    gitlab.refusals.set("carol", () => json({ message: "upstream detail" }, { status: 500 }));
    const gk = await binding();

    // GitLab's own text stays out of the error, which the Workshop logs and shows.
    const failed = await gk.verify({ alice, carol });
    expect(failed).toEqual({ error: expect.stringContaining("GitLab could not check access (500)") });
    expect(failed).not.toEqual({ error: expect.stringContaining("upstream detail") });
    // Not remembered as a denial: once GitLab answers, carol is allowed.
    gitlab.refusals.delete("carol");
    expect(await gk.verify({ alice, carol })).toEqual({ ok: ["alice", "carol"] });
  });

  it("reuses an account's answer, a grant for 15 minutes and a denial for 15 seconds", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("bob");
    // Two bindings of the same project share each account's answers.
    const [first, second] = [await binding(), await binding()];
    const start = Date.now();
    const at = (offset: number) => vi.setSystemTime(start + offset);
    const asked = (token: string) => gitlab.requestsWith(token).filter(path => path.endsWith("/members/all")).length;

    expect(await first.verify({ alice, bob })).toEqual({ ok: ["alice"] });
    at(14_000);
    expect(await second.verify({ alice, bob })).toEqual({ ok: ["alice"] });
    expect([asked("alice"), asked("bob")]).toEqual([1, 1]);

    // Bob is made a member, and alice is removed.
    gitlab.member("bob", { [PROJECT_ID]: REPORTER });
    gitlab.users.get("alice")!.levels.clear();
    at(16_000);
    expect(await first.verify({ alice, bob })).toEqual({ ok: ["alice", "bob"] });
    // Each answer is dated from when GitLab was asked: alice's grant has expired, bob's not yet.
    at(15 * MINUTE + 1_000);
    expect(await first.verify({ alice, bob })).toEqual({ ok: ["bob"] });
    expect([asked("alice"), asked("bob")]).toEqual([2, 2]);
  });

  it("reuses an allowed answer for a running job only as long as a denial", async () => {
    // The runner may yet mark the log a debug trace, which GitLab then shows only to Developers.
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const reporter = await account("reporter");
    gitlab.member("reporter", { [PROJECT_ID]: REPORTER });
    gitlab.runningJobs.add(8);
    const gk = await binding();
    const start = Date.now();
    const at = (offset: number) => vi.setSystemTime(start + offset);
    const trace = [`project/${PROJECT_ID}/jobTrace/8`];

    expect(await gk.verify({ reporter }, trace)).toEqual({ ok: ["reporter"] });
    gitlab.debugJobs.add(8);
    at(14_000);
    expect(await gk.verify({ reporter }, trace)).toEqual({ ok: ["reporter"] });
    at(16_000);
    expect(await gk.verify({ reporter }, trace)).toEqual({ ok: [] });
  });

  it("serves no remembered answer once the account's credentials are confirmed dead", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    const gk = await binding();

    expect(await gk.verify({ alice })).toEqual({ ok: ["alice"] });
    // GitLab rejects alice's token, and refuses her refresh token: her account records it dead.
    await hooks().installCallback(alice);
    expect(await hooks().reportTokenRejected(alice, "alice")).toBe("expired");

    // Access can no longer be determined, so the check fails rather than reuse the grant.
    expect(await gk.verify({ alice })).toEqual({ error: expect.stringMatching(/expired|revoked/i) });
    expect(gitlab.requestsWith("alice").filter(path => path.endsWith("/members/all"))).toHaveLength(1);
  });

  it("keys answers by account, not observer, and asks again after the account reconnects", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("bob");
    gitlab.member("access-1");
    const gk = await binding();

    expect(await gk.verify({ observer: alice })).toEqual({ ok: ["observer"] });
    // The same observer, with another account's verifier.
    expect(await gk.verify({ observer: bob })).toEqual({ ok: [] });

    // Alice's connection is replaced by one signed in as another GitLab user, who is no member.
    gitlab.oauth = () => json(tokenResponse(1));
    await hooks().installCallback(alice);
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(alice)), async instance => {
      await instance.commitReconnect(await stageReconnect(instance, "code-1"));
    });
    expect(await gk.verify({ observer: alice })).toEqual({ ok: [] });
    expect(gitlab.requestsWith("access-1")).toEqual(["/api/v4/user", `/api/v4/projects/${PROJECT_ID}/members/all`]);
  });

  it("refuses to answer for a check the account reconnected during, its answers two users' combined", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("access-1");
    const gk = await binding();
    const trace = `project/${PROJECT_ID}/jobTrace/8`;

    // As GitLab answers alice's membership, her connection is replaced by another GitLab user's,
    // who is no member: the job, hidden from them, would read as deleted and so allowed.
    gitlab.oauth = () => json(tokenResponse(1));
    await hooks().installCallback(alice);
    let reconnected = false;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${PROJECT_ID}/members/all`), async request => {
      if (!reconnected) {
        reconnected = true;
        await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(alice)), async instance => {
          await instance.commitReconnect(await stageReconnect(instance, "code-1"));
        });
      }
      const level = gitlab.users.get(tokenOf(request))?.levels.get(PROJECT_ID);
      return level === undefined ? json([]) : json([{ id: gitlab.users.get(tokenOf(request))!.id, access_level: level }]);
    });

    expect(await gk.verify({ observer: alice }, [trace])).toEqual({ error: expect.stringContaining("changed while access") });
    // Asked again, the new user is checked throughout.
    expect(await gk.verify({ observer: alice }, [trace])).toEqual({ ok: [] });
  });

  it.each([
    "gitlab/project/42", "project/042", "project/abc", "project/-1", "project/0", "project/9007199254740993",
    "project/42/role/reporter", "project/42/role/owner", "project/42/issue/7", "role/developer",
    "project/42/role/developer/role/maintainer", "project/4%32", "project/42/jobTrace/08",
    "project/42/jobArtifacts/x", "project/42/jobTrace/8/jobArtifacts/8", "jobTrace/8",
  ])("refuses the whole call for %s, asking no one", async id => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.member("alice", { [PROJECT_ID]: MAINTAINER_LEVEL });
    const gk = await binding();

    expect(await gk.verify({ alice }, [PROJECT, id])).toEqual({ error: expect.any(String) });
    expect(gitlab.requests).toEqual([]);
  });
});

describe("addObserver", () => {
  it("requires Reporter on the pinned project by its id, and on the one its path names, asked each time", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, bob, carol] = await Promise.all([account("alice"), account("bob"), account("carol")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("bob", { [OTHER_ID]: MAINTAINER_LEVEL });
    gitlab.member("carol", { [PROJECT_ID]: REPORTER });
    gitlab.refusals.set("carol", () => json({ message: "500 Internal Server Error" }, { status: 500 }));
    const gk = await binding({ pinned: true });

    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    // Its path is read at the project's root, then its membership by the id that names.
    expect(gitlab.requestsWith("alice").filter(path => path.endsWith("/members/all")))
      .toEqual(Array(4).fill(`/api/v4/projects/${PROJECT_ID}/members/all`));
    expect(gitlab.requestsWith("alice").filter(path => path === "/api/v4/projects/group%2Fsub%2Fproject"))
      .toHaveLength(2);
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
    // An answer that says nothing about access fails admission, as an error rather than a denial.
    expect(await gk.admit(carol)).toEqual({ error: expect.stringContaining("500") });

    // The project moves, and another takes its path. A release that read by path may have read
    // that one, so an observer must be a member of it too: alice no longer passes, bob still not.
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    gitlab.projects.set(OTHER_ID, PATH);
    expect(await gk.admit(alice)).toEqual({ error: expect.stringContaining("does not have read access") });
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
    gitlab.member("alice", { [OTHER_ID]: REPORTER });
    expect(await gk.admit(alice)).toEqual({ ok: undefined });
  });

  it("admits anyone to a new binding, uncapped and without asking GitLab, leaving its reads to be checked", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("bob", { [OTHER_ID]: MAINTAINER_LEVEL });
    const gk = await binding({ pinned: true, reportsSubresources: true });
    // Renamed, and another project at the old path: an older binding would refuse everyone now.
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    gitlab.projects.set(OTHER_ID, PATH);

    // One past the 50 collaborators an older binding records.
    for (let index = 0; index <= 50; index++) {
      expect(await gk.admit(bob, `bob-${index}`)).toEqual({ ok: undefined });
    }
    expect(gitlab.requests).toEqual([]);
    // What its reads reported, the project by its id, only alice can see.
    expect(await gk.verify({ alice, bob })).toEqual({ ok: ["alice"] });
  });

  it("follows a moved project's redirect from its old path in legacy admission, as GitHub does", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.member("alice", { [PROJECT_ID]: MAINTAINER_LEVEL });
    gitlab.member("bob", { [OTHER_ID]: MAINTAINER_LEVEL });
    const gk = await binding({ pinned: true });
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    gitlab.formerPaths.set(PATH, PROJECT_ID);

    expect(await gk.verify({ alice })).toEqual({ ok: ["alice"] });
    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
  });

  it("pins a project that moved before its first read through its old path's redirect", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.issues = [1];
    gitlab.install();
    const gk = await binding();
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    gitlab.formerPaths.set(PATH, PROJECT_ID);

    expect(await gk.read([{ method: "listIssues", drain: true }])).toMatchObject({ ok: [{ id: "1" }] });
    expect((await gk.observations()).map(observation => observation.subresources)).toEqual([[PROJECT]]);
  });

  it("admits an observer on their own membership by path while no id is stored, never asking the owner", async () => {
    // A binding not read since ids were pinned has read nothing by id, and its owner's grant may
    // have lapsed since; that must not keep out collaborators who can see the project themselves.
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, bob] = await Promise.all([account("alice"), account("bob")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("bob");
    const gk = await binding();
    await hooks().installCallback(gk.owner);
    expect(await hooks().reportTokenRejected(gk.owner, OWNER_TOKEN)).toBe("expired");

    expect(await gk.admit(alice)).toEqual({ ok: undefined });
    expect(await gk.admit(bob)).toEqual({ error: expect.stringContaining("does not have read access") });
    expect(gitlab.requestsWith("alice").filter(path => path.endsWith("/members/all")))
      .toEqual([`/api/v4/projects/${PROJECT_ID}/members/all`]);
    expect(gitlab.requestsWith(OWNER_TOKEN)).toEqual([]);
  });
});
