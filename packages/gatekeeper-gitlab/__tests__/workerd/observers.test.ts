// Collaborator ("observer") verification for GitLab bindings, through the real gatekeeper and
// UserAccount Durable Objects with GitLab faked at `fetch`: what each read reports to the Workshop,
// CI data's role included, how verifyObserverAccess and addObserver answer, and how both hold up
// when the bound project is renamed or transferred, deleted, or its path taken by another project.

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
/** What a read of data only Developers see reports. */
const DEVELOPER = `project/${PROJECT_ID}/role/developer`;
/** What a read of data only Maintainers may see reports. */
const MAINTAINER = `project/${PROJECT_ID}/role/maintainer`;
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
  /** How GitLab answers a token exchange or refresh. */
  oauth: () => Response = () => json(fx.oauthInvalidGrantResponse.data, { status: 400 });

  constructor() {
    super();
    this.member(OWNER_TOKEN, { [PROJECT_ID]: MAINTAINER_LEVEL, [OTHER_ID]: MAINTAINER_LEVEL });
    this.on("GET", /^\/api\/v4\//, request => this.#rest(request));
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
    const firstPage = (request.url.searchParams.get("page") ?? "1") === "1";
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
      case "/jobs/8":
        return json({ ...fx.jobResponse.data, id: 8, status: "success",
          pipeline: { ...fx.jobResponse.data.pipeline, id: 6, project_id: PROJECT_ID } });
      case "/jobs/8/trace":
        return new Response("hello\n");
      default:
        return notFound;
    }
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

  it("report the role CI data needs, chosen as it was read and never again", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    // The owner is a Developer when the test report is read, and a Maintainer as soon as GitLab has
    // answered for that membership once.
    let ownerAsked = 0;
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${PROJECT_ID}/members/all\\?`), request => {
      const owner = gitlab.users.get(OWNER_TOKEN)!;
      if (Number(request.url.searchParams.get("user_ids[]")) !== owner.id) return json([]);
      return json([{ id: owner.id, access_level: ownerAsked++ === 0 ? DEVELOPER_LEVEL : MAINTAINER_LEVEL }]);
    });
    const gk = await binding();

    // A job's log, which a debug trace can fill with CI/CD variables only Developers see.
    expect(await gk.read([{ method: "getJob", args: ["8"] }, { method: "readLog" }]))
      .toMatchObject({ ok: { lines: [{ number: 1 }] } });
    // Failed tests read through a Developer, whose reports leave out what only Maintainers may
    // download: each page reports Developer, though the owner is a Maintainer by the time they leave.
    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "listFailedTests", args: [{ resultsPerPage: 1 }], drain: true }]))
      .toMatchObject({ ok: [{ name: "first" }, { name: "second" }] });
    expect(ownerAsked).toBe(1);
    // Read again now, through a Maintainer, the report may hold more, so it needs Maintainer.
    expect(await gk.read([{ method: "getPipeline", args: ["6"] }, { method: "getTestReport" }])).toMatchObject({ ok: {} });

    expect(await gk.observations()).toEqual([
      { title: "Read log of job `rubocop` #8, lines 1–1", subresources: [DEVELOPER] },
      { title: "Read failed tests of pipeline #6", subresources: [DEVELOPER] },
      { title: "Read failed tests of pipeline #6 (page 2)", subresources: [DEVELOPER] },
      { title: "Read test report of pipeline #6", subresources: [MAINTAINER] },
    ]);
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
  it("allows an observer whose membership of the project reaches the role each ID names", async () => {
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

    expect(await gk.verify(everyone, [PROJECT])).toEqual({ ok: ["reporter", "developer", "maintainer"] });
    expect(await gk.verify(everyone, [DEVELOPER])).toEqual({ ok: ["developer", "maintainer"] });
    expect(await gk.verify(everyone, [MAINTAINER])).toEqual({ ok: ["maintainer"] });
    // Each observer is asked with their own token, by the project's id.
    expect(gitlab.requestsWith("reporter")).toEqual([
      "/api/v4/user", ...Array(3).fill(`/api/v4/projects/${PROJECT_ID}/members/all`),
    ]);
    // The binding's own account was never asked.
    expect(gitlab.requestsWith(OWNER_TOKEN)).toEqual([]);
  });

  it("fails, denying no one for good, when an outage keeps GitLab from answering", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const [alice, carol] = await Promise.all([account("alice"), account("carol")]);
    gitlab.member("alice", { [PROJECT_ID]: REPORTER });
    gitlab.member("carol", { [PROJECT_ID]: REPORTER });
    gitlab.refusals.set("carol", () => json({ message: "500 Internal Server Error" }, { status: 500 }));
    const gk = await binding();

    expect(await gk.verify({ alice, carol })).toEqual({ error: expect.any(String) });
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

  it.each([
    "gitlab/project/42", "project/042", "project/abc", "project/-1", "project/0", "project/9007199254740993",
    "project/42/role/reporter", "project/42/role/owner", "project/42/issue/7", "role/developer",
    "project/42/role/developer/role/maintainer", "project/4%32",
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
    expect(gitlab.requestsWith("alice").filter(path => path.endsWith("/members/all")).toSorted()).toEqual([
      ...Array(2).fill(`/api/v4/projects/${PROJECT_ID}/members/all`),
      ...Array(2).fill("/api/v4/projects/group%2Fsub%2Fproject/members/all"),
    ].toSorted());
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

  it("keeps legacy admission closed on a freed path's redirect after a plain rename", async () => {
    const gitlab = new ObserverGitLab();
    gitlab.install();
    const alice = await account("alice");
    gitlab.member("alice", { [PROJECT_ID]: MAINTAINER_LEVEL });
    const gk = await binding({ pinned: true });
    gitlab.projects.set(PROJECT_ID, "acme/renamed");
    gitlab.formerPaths.set(PATH, PROJECT_ID);

    // Modern reads and verification still follow the pinned id. Earlier path-addressed history
    // cannot prove that it never read a replacement that also subsequently moved away.
    expect(await gk.verify({ alice })).toEqual({ ok: ["alice"] });
    expect(await gk.admit(alice)).toEqual({ error: expect.stringMatching(/renamed or transferred/) });
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
      .toEqual(["/api/v4/projects/group%2Fsub%2Fproject/members/all"]);
    expect(gitlab.requestsWith(OWNER_TOKEN)).toEqual([]);
  });
});
