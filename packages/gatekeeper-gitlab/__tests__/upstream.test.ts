// The requests this gatekeeper makes to GitLab and the name each is counted under, whatever the
// instance, and what the gatekeeper decides about a call that the client cannot know: a rename's
// redirect it re-issues is a success, a token response without its tokens is an error inside a
// 200, git reports a refused push inside a 200, a job's log is counted by how the reading of it
// ends, which requests are sent again, and how long each may take.

import { env } from "cloudflare:workers";
import { CiLogTooLargeError, readCiLog } from "@gadgets/gatekeeper-kit/ci";
import {
  encodePktLine, FLUSH_PKT, GitRefUpdateRejectedError, MAX_RECEIVE_PACK_RESPONSE_BYTES, pushGitRefUpdate,
} from "@gadgets/gatekeeper-kit/git-transport";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAuthCode, GitLabApi, GitLabApiError, refreshAccessToken, revokeToken, type GitLabInstance,
} from "../src/gitlab-api";
import { normalizeGitLabLogLine } from "../src/gitlab-normalize";
import {
  GITLAB_OPERATIONS, gitlabApiBase, gitlabRoutes, gitlabUpstream, gitlabUpstreamAt, type GitLabOperation,
} from "../src/gitlab-upstream";

type Row = [method: string, url: string, name: string];

/** Every kind of request made beneath a project, by its path there, with the name it is counted under. */
const PROJECT_REQUESTS: [method: string, path: string, name: string][] = [
  ["GET", "/members/all?user_ids%5B%5D=7&per_page=100", "members.all"],
  ["GET", "/issues?with_labels_details=true&page=1&per_page=20", "issues.list"],
  ["POST", "/issues", "issues.create"],
  ["GET", "/issues/3?with_labels_details=true", "issues.get"],
  ["PUT", "/issues/3", "issues.update"],
  ["POST", "/issues/3/notes", "notes.create"],
  ["DELETE", "/issues/3/notes/9", "notes.delete"],
  ["GET", "/issues/3/discussions?page=1&per_page=100", "discussions.list"],
  ["GET", "/merge_requests?state=all&with_labels_details=true&page=1&per_page=20", "merge_requests.list"],
  ["POST", "/merge_requests", "merge_requests.create"],
  ["GET", "/merge_requests/5?with_labels_details=true", "merge_requests.get"],
  ["PUT", "/merge_requests/5", "merge_requests.update"],
  ["GET", "/merge_requests/5/approvals", "approvals.get"],
  ["POST", "/merge_requests/5/approve", "merge_requests.approve"],
  ["POST", "/merge_requests/5/unapprove", "merge_requests.unapprove"],
  ["PUT", "/merge_requests/5/merge", "merge_requests.merge"],
  ["GET", "/merge_requests/5/diffs?page=1&per_page=100", "diffs.list"],
  ["GET", "/merge_requests/5/commits?page=1&per_page=100", "commits.list"],
  ["GET", "/merge_requests/5/pipelines?page=1&per_page=100", "pipelines.list"],
  ["GET", "/merge_requests/5/versions?page=1&per_page=100", "versions.list"],
  ["POST", "/merge_requests/5/notes", "notes.create"],
  ["DELETE", "/merge_requests/5/notes/9", "notes.delete"],
  ["GET", "/merge_requests/5/discussions?page=1&per_page=100", "discussions.list"],
  ["PUT", "/merge_requests/5/discussions/6a9c1750b37d513a43987b574953fceb50b03ce7", "discussions.update"],
  ["POST", "/merge_requests/5/discussions/6a9c1750b37d513a43987b574953fceb50b03ce7/notes", "notes.create"],
  ["GET", "/merge_requests/5/draft_notes", "draft_notes.list"],
  ["POST", "/merge_requests/5/draft_notes", "draft_notes.create"],
  ["PUT", "/merge_requests/5/draft_notes/11/publish", "draft_notes.publish"],
  ["DELETE", "/merge_requests/5/draft_notes/11", "draft_notes.delete"],
  ["POST", "/merge_requests/5/draft_notes/bulk_publish", "draft_notes.bulk_publish"],
  ["GET", "/repository/branches?page=1&per_page=100", "branches.list"],
  ["GET", "/repository/branches/feature%2Fx", "branches.get"],
  ["GET", "/repository/tags?page=1&per_page=100", "tags.list"],
  ["GET", "/repository/commits?ref_name=main&page=1&per_page=20", "commits.list"],
  ["GET", "/repository/commits/release%2F1?stats=true", "commits.get"],
  ["GET", "/repository/commits/4b825dc642cb6eb9a060e54bf8d69288fbee4904/statuses?pipeline_id=7&page=1&per_page=100", "statuses.list"],
  ["GET", "/repository/compare?from=main&to=feature%2Fx", "repository.compare"],
  ["GET", "/repository/merge_base?refs%5B%5D=main&refs%5B%5D=feature%2Fx", "repository.merge_base"],
  ["GET", "/repository/blobs/e69de29bb2d1d6434b8b29ae775ad8c2e48c5391/raw", "blobs.raw"],
  ["GET", "/protected_branches?page=1&per_page=100", "protected_branches.list"],
  ["GET", "/events?action=pushed&page=1&per_page=100", "events.list"],
  ["GET", "/pipelines?ref=main&page=1&per_page=20", "pipelines.list"],
  ["GET", "/pipelines/7", "pipelines.get"],
  ["GET", "/pipelines/7/jobs?page=1&per_page=100", "jobs.list"],
  ["GET", "/pipelines/7/trigger_jobs?page=1&per_page=100", "trigger_jobs.list"],
  ["GET", "/pipelines/7/bridges?page=1&per_page=100", "bridges.list"],
  ["GET", "/pipelines/7/test_report_summary", "test_report_summary.get"],
  ["GET", "/pipelines/7/test_report", "test_report.get"],
  ["GET", "/jobs/8", "jobs.get"],
  ["GET", "/jobs/8/trace", "jobs.trace"],
  // The one request the tree has no verb for, named by the upstream's own namer.
  ["HEAD", "/repository/files/.gitlab-ci.yml?ref=main", "files.head"],
];

/**
 * Every kind of request the gatekeeper makes under the API's root at `base`. One beneath a project
 * is made by the project's id and, before the id is known, by its path as one encoded segment.
 */
function requestsAt(base: string): Row[] {
  return [
    ["GET", `${base}user`, "user.get"],
    ["GET", `${base}metadata`, "metadata.get"],
    ["GET", `${base}users?username=ada`, "users.list"],
    ["GET", `${base}users/7`, "users.get"],
    ["GET", `${base}projects?membership=true&order_by=last_activity_at&sort=desc&page=1&per_page=20`, "projects.list"],
    ["GET", `${base}projects/42`, "projects.get"],
    ["GET", `${base}projects/group%2Fsub%2Fproject`, "projects.get"],
    ...PROJECT_REQUESTS.flatMap(([method, path, name]): Row[] => [
      [method, `${base}projects/42${path}`, name],
      [method, `${base}projects/group%2Fsub%2Fproject${path}`, name],
    ]),
  ];
}

/** The API roots the table is read under: gitlab.com's, and a self-hosted one beneath a path. */
const DOT_COM = gitlabApiBase("https://gitlab.com");
const SELF_HOSTED = "https://git.example.test/gitlab/api/v4/";
const BASES = [DOT_COM, SELF_HOSTED];

const INSTANCE: GitLabInstance = { apiOrigin: "https://gitlab.example.com", headers: {} };
const API = gitlabApiBase(INSTANCE.apiOrigin);

const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";
  // No wait between the attempts of a request that is sent again.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its operation, outcome, reason, detail and HTTP status.
function calls() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.detail, SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

type Sent = { method: string; url: string; init: RequestInit };

// A global fetch that gives each of `answers` in turn, and the last of them from then on. It
// returns what it was sent.
function answering(...answers: (() => Response)[]): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? "GET", url: String(input), init });
    const next = answers[Math.min(sent.length, answers.length) - 1];
    if (next === undefined) throw new Error("the test listed no answer");
    return next();
  }));
  return sent;
}

const json = (body: unknown, init?: ResponseInit) => () => Response.json(body, init);
const empty = (status: number, headers?: Record<string, string>) => () => new Response(null, { status, headers });
const pack = (service: string) => () =>
  new Response("0000", { headers: { "content-type": `application/x-${service}-result` } });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

// What a push ends with: nothing, or the class and the message of what it threw.
async function ending(pushed: Promise<void>): Promise<unknown> {
  try {
    return await pushed;
  } catch (error) {
    return error instanceof Error ? [error.constructor, error.message] : error;
  }
}

// The content type GitLab answers a receive-pack with.
const PUSH_RESULT = { "content-type": "application/x-git-receive-pack-result" };
// A receive-pack's answer: a 200 of that type whose body is the report-status of these lines.
const report = (...lines: string[]) => () =>
  new Response(new Blob([...lines.map(encodePktLine), FLUSH_PKT]), { headers: PUSH_RESULT });
const landed = report("unpack ok", "ok refs/heads/main");
const packed = () => new Blob(["PACK"]).stream();

const api = () => new GitLabApi(INSTANCE, async () => "test-token");
// Reads the log of a job as the gatekeeper does, each line rewritten by `normalizeLine`.
const trace = (normalizeLine = normalizeGitLabLogLine) =>
  api().getJobTrace("g/p", 8, log => readCiLog(log, normalizeLine));
// The oid of a blob.
const BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const APP = { clientId: "app", clientSecret: "client-secret" };
const exchange = () => exchangeAuthCode(INSTANCE, {
  ...APP, code: "code", redirectUri: "https://gadgets.example/oauth", codeVerifier: "verifier",
});
const refresh = () => refreshAccessToken(INSTANCE, { ...APP, refreshToken: "refresh-token" });
const GRANT = { access_token: "access-token", refresh_token: "refresh-token", expires_in: 7200 };

describe.each(BASES)("the names of GitLab's requests under %s", base => {
  const upstream = gitlabUpstreamAt(base);
  const requests = requestsAt(base);

  it.each(requests)("names %s %s as %s", (method, url, name) => {
    expect(upstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(gitlabRoutes(base))).toHaveLength(32);
    expect(unreachedRouteEnds(gitlabRoutes(base), requests)).toEqual([]);
  });

  it.each<Row>([
    ["GET", `${base}groups/9`, "GET"],
    ["POST", `${base}projects/42/issues/3/move`, "POST"],
    ["DELETE", `${base}projects/42/hooks/1`, "DELETE"],
    // Only the HEAD of a repository file has a name.
    ["HEAD", `${base}projects/42`, "HEAD"],
    ["HEAD", `${base}projects/42/repository/files/src/main.ts`, "HEAD"],
    // The OAuth and git endpoints lie outside the API's root: each is named where it is sent.
    ["POST", new URL("/oauth/token", base).href, "POST"],
    ["POST", new URL("/group/sub/project.git/git-upload-pack", base).href, "POST"],
  ])("names %s %s, which no path of the tree is, by its method", (method, url, name) => {
    expect(upstream.operationOf(method, url)).toBe(name);
  });

  it("names nothing by the paths of another instance", () => {
    const other = BASES.find(candidate => candidate !== base);
    expect(upstream.operationOf("GET", `${other}user`)).toBe("GET");
  });
});

describe("the routes of an instance", () => {
  it("are made once for each base, and hold the base as their only root", () => {
    expect(gitlabRoutes(DOT_COM)).toBe(gitlabRoutes(DOT_COM));
    expect(gitlabUpstreamAt(DOT_COM)).toBe(gitlabUpstreamAt(DOT_COM));
    expect(gitlabRoutes(DOT_COM).map(([root]) => root)).toEqual(["https://gitlab.com/api/v4/"]);
    expect(gitlabRoutes(SELF_HOSTED).map(([root]) => root)).toEqual([SELF_HOSTED]);
    // The tree is the same whatever the instance: only the root differs.
    expect(gitlabRoutes(SELF_HOSTED)[0][1]).toBe(gitlabRoutes(DOT_COM)[0][1]);
  });

  it("reads a base given without its closing slash as the same root", () => {
    expect(gitlabRoutes("https://gitlab.com/api/v4")).toBe(gitlabRoutes(DOT_COM));
  });

  it("counts every request under the source of the vendor and the service gitlab", async () => {
    answering(json({ id: 1, username: "ada" }));
    await api().getCurrentUser();
    expect(gitlabUpstream.source).toBe("gatekeeper.gitlab.api");
    expect(gitlabUpstreamAt(API).source).toBe("gatekeeper.gitlab.api");
    expect(points.map(point => [
      column(point, SUBSERVICE_V1_SLOTS.source), column(point, SUBSERVICE_V1_SLOTS.service),
      column(point, SUBSERVICE_V1_SLOTS.operation),
    ])).toEqual([["gatekeeper.gitlab.api", "gitlab", "user.get"]]);
  });
});

describe("the requests no path names", () => {
  // Each literal name, with the call that sends the request it names and the answer it is given.
  const LITERALS = {
    "files.head": {
      url: `${API}projects/g%2Fp/repository/files/.gitlab-ci.yml?ref=main`,
      answer: empty(200),
      send: () => api().fileExists("g/p", ".gitlab-ci.yml", "main"),
    },
    "token.exchange": { url: "https://gitlab.example.com/oauth/token", answer: json(GRANT), send: exchange },
    "token.refresh": { url: "https://gitlab.example.com/oauth/token", answer: json(GRANT), send: refresh },
    "token.revoke": {
      url: "https://gitlab.example.com/oauth/revoke",
      answer: json({}),
      send: () => revokeToken(INSTANCE, { ...APP, token: "access-token" }),
    },
    "git.upload-pack": {
      url: "https://gitlab.example.com/g/p.git/git-upload-pack",
      answer: pack("git-upload-pack"),
      send: () => api().fetchGitUploadPack("g/p", new Uint8Array([48, 48, 48, 48])),
    },
    "git.receive-pack": {
      url: "https://gitlab.example.com/g/p.git/git-receive-pack",
      answer: landed,
      send: () => api().fetchGitReceivePack("g/p", "main", packed()),
    },
  } satisfies Record<GitLabOperation, { url: string; answer: () => Response; send: () => Promise<unknown> }>;

  it("sends a request for every literal name, and lists none twice", () => {
    expect(Object.keys(LITERALS).toSorted()).toEqual(GITLAB_OPERATIONS.toSorted());
    expect(new Set(GITLAB_OPERATIONS).size).toBe(GITLAB_OPERATIONS.length);
  });

  it.each(Object.entries(LITERALS))("counts a request under %s", async (name, { url, answer, send }) => {
    const sent = answering(answer);
    await send();
    expect(sent.map(request => request.url)).toEqual([url]);
    expect(calls()).toEqual([[name, "success", "", "", 200]]);
  });
});

describe("how GitLab's answers are counted", () => {
  it("counts a renamed project's redirect that is re-issued as a success, and the request it is re-issued as", async () => {
    const sent = answering(empty(301, { location: "https://gitlab.example.com/api/v4/projects/81" }), json({ id: 81 }));
    expect(await api().getProject("old/path")).toEqual({ id: 81 });
    expect(sent.map(({ url }) => url)).toEqual([`${API}projects/old%2Fpath`, `${API}projects/81`]);
    expect(sent.map(({ init }) => init.redirect)).toEqual(["manual", "manual"]);
    expect(calls()).toEqual([["projects.get", "success", "", "", 301], ["projects.get", "success", "", "", 200]]);
  });

  it("counts a redirect that is refused as an error, and follows none", async () => {
    const sent = answering(
      empty(301, { location: "https://gitlab.example.com/api/v4/projects/81/issues/3" }),
      empty(302, { location: "https://login.example.test/sign-in" }),
    );
    expect(await rejection(api().getIssue("old/path", 3))).toMatchObject({ name: "GitLabApiError", status: 301 });
    expect(await rejection(api().createIssue("g/p", { title: "t" }))).toMatchObject({ name: "GitLabApiError", status: 302 });
    expect(sent).toHaveLength(2);
    expect(calls()).toEqual([["issues.get", "error", "http", "", 301], ["issues.create", "error", "http", "", 302]]);
  });

  it("counts a status the caller reads as an answer by that status", async () => {
    answering(json({ message: "404 Blob Not Found" }, { status: 404 }));
    expect(await api().getBlob("g/p", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", 1024)).toBeNull();
    expect(calls()).toEqual([["blobs.raw", "error", "http", "", 404]]);
  });

  it("counts a blob whose transfer is cut off after its headers as no success, and throws what cut it off", async () => {
    const cut = new TypeError("connection lost");
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new Uint8Array(16)),
      pull: controller => controller.error(cut),
    })));
    expect(await rejection(api().getBlob("g/p", BLOB, 1024))).toBe(cut);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["blobs.raw", "error", "parse", "", 200]]);
  });

  it("counts a blob that is read whole, and one longer than its cap, as the successes they are answered as", async () => {
    const sent = answering(() => new Response("blob"), () => new Response(new Uint8Array(2048)));
    expect(await api().getBlob("g/p", BLOB, 1024)).toEqual(new Uint8Array(new TextEncoder().encode("blob")));
    expect(await api().getBlob("g/p", BLOB, 1024)).toBe("oversized");
    expect(sent).toHaveLength(2);
    expect(calls()).toEqual([["blobs.raw", "success", "", "", 200], ["blobs.raw", "success", "", "", 200]]);
  });

  it("counts a body that is not the JSON it claims to be as a parse error, and throws what reading it threw", async () => {
    const sent = answering(() => new Response("{not json", { headers: { "content-type": "application/json" } }));
    const error = await rejection(api().getProject("g/p"));
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).not.toBeInstanceOf(GitLabApiError);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["projects.get", "error", "parse", "", 200]]);
  });

  it.each<[string, (gitlab: GitLabApi) => Promise<unknown>, () => Response, string, string]>([
    ["a page of a listing answered with no body", gitlab => gitlab.listBranches("g/p", { page: 1, perPage: 100 }),
      () => new Response(""), "branches.list", "Cannot read properties of undefined (reading 'length')"],
    ["a page of a listing that holds nothing", gitlab => gitlab.listIssues("g/p", { page: 1, perPage: 20 }), json(null),
      "issues.list", "Cannot read properties of null (reading 'length')"],
    ["the instance's version answered with no body", gitlab => gitlab.getVersion(), () => new Response(""), "metadata.get",
      "Cannot read properties of undefined (reading 'version')"],
    ["a user that holds nothing, asked whether it is a bot", gitlab => gitlab.isBotUser(7), json(null), "users.get",
      "Cannot read properties of null (reading 'bot')"],
    ["a project's members that are no list", gitlab => gitlab.getProjectMember(42, 7), json({}), "members.all",
      "rows is not iterable"],
    ["a project's member that is none", gitlab => gitlab.getProjectMember(42, 7), json([null]), "members.all",
      "Cannot read properties of null (reading 'id')"],
  ])("counts %s as an error of the API, sent once and failing as its reading does", async (_what, send, answer, operation, message) => {
    const sent = answering(answer);

    const thrown = await rejection(send(api()));

    expect(Object.getPrototypeOf(thrown)).toBe(TypeError.prototype);
    expect(thrown).toMatchObject({ message });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([[operation, "error", "api", "", 200]]);
  });

  it("counts a listing that is no list as an error of the API, and refuses it within the request", async () => {
    answering(json({}));
    const refusal = { name: "GitLabApiError", status: 502, message: "GitLab answered a listing with no list." };
    expect(await rejection(api().listDraftNotes("g/p", 5))).toMatchObject(refusal);
    expect(await rejection(api().listBranches("g/p", { page: 1, perPage: 100 }))).toMatchObject(refusal);
    expect(calls()).toEqual([["draft_notes.list", "error", "api", "", 200], ["branches.list", "error", "api", "", 200]]);
  });

  it("counts a listing that is empty as a page", async () => {
    answering(json([]));
    expect(await api().listDraftNotes("g/p", 5)).toEqual([]);
    expect(calls()).toEqual([["draft_notes.list", "success", "", "", 200]]);
  });

  it.each<[string, string, (gitlab: GitLabApi) => Promise<unknown>]>([
    ["fetch", "git.upload-pack", gitlab => gitlab.fetchGitUploadPack("g/p", new Uint8Array([48, 48, 48, 48]))],
    ["push", "git.receive-pack", gitlab => gitlab.fetchGitReceivePack("g/p", "main", new Blob(["0000"]).stream())],
  ])("counts a git %s answered 200 by what is no git result as the error it is thrown as", async (verb, operation, send) => {
    const sent = answering(() => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(await rejection(send(api()))).toMatchObject({
      name: "GitLabApiError", status: 502, message: expect.stringContaining(`git ${verb} failed: expected application/x-`),
    });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([[operation, "error", "parse", "", 200]]);
  });

  it("counts a git fetch answered a pack with no body as an error, and hands a pack on unread", async () => {
    const bodiless = answering(() => new Response(null, { headers: { "content-type": "application/x-git-upload-pack-result" } }));
    const answered = await api().fetchGitUploadPack("g/p", new Uint8Array([48, 48, 48, 48]));
    // The transport refuses an answer with no body in its own words.
    expect(answered.body).toBeNull();
    expect(bodiless).toHaveLength(1);
    expect(calls()).toEqual([["git.upload-pack", "error", "parse", "", 200]]);

    points.length = 0;
    answering(pack("git-upload-pack"));
    const streamed = await api().fetchGitUploadPack("g/p", new Uint8Array([48, 48, 48, 48]));
    expect(streamed.bodyUsed).toBe(false);
    expect(await streamed.text()).toBe("0000");
    expect(calls()).toEqual([["git.upload-pack", "success", "", "", 200]]);
  });

  it.each([
    ["exchange", "token.exchange", exchange],
    ["refresh", "token.refresh", refresh],
  ])("counts a token %s whose 200 lacks a token as an error inside a success", async (_name, operation, send) => {
    answering(json({ access_token: "access-token", token_type: "bearer" }));
    expect(await rejection(send())).toMatchObject({ name: "GitLabApiError", status: 400 });
    expect(calls()).toEqual([[operation, "error", "api", "", 200]]);
  });

  it("counts a token request the endpoint refuses, or redirects, by its status", async () => {
    answering(
      json({ error: "invalid_grant" }, { status: 400 }),
      empty(302, { location: "https://login.example.test/sign-in" }),
    );
    expect(await rejection(refresh())).toMatchObject({ name: "CredentialsExpiredError" });
    expect(await rejection(exchange())).toMatchObject({ name: "GitLabApiError", status: 302 });
    expect(calls()).toEqual([["token.refresh", "error", "http", "", 400], ["token.exchange", "error", "http", "", 302]]);
  });
});

describe("how a push is counted, by the report git answers it with", () => {
  const OLD = "1".repeat(40);
  const NEW = "2".repeat(40);
  const UPDATE = { branch: "main", oldSha: OLD, newSha: NEW };
  const URL_SENT = "https://gitlab.example.com/g/p.git/git-receive-pack";

  // Pushes an update of `main` through the kit's transport, as the gatekeeper does.
  const push = () => pushGitRefUpdate(body => api().fetchGitReceivePack("g/p", "main", body), UPDATE, packed());

  // The answers GitLab gives a push with a 200 of the git result type, each with the outcome and
  // the reason the request is counted with.
  const REPORTS: [name: string, counted: "success" | "error api" | "error parse", answer: () => Response][] = [
    ["applied the update", "success", landed],
    ["refused an update that is no fast-forward", "error api", report("unpack ok", "ng refs/heads/main fetch first")],
    ["refused an update of a protected branch", "error api",
      report("unpack ok", "ng refs/heads/main GitLab: You are not allowed to push code to protected branches on this project.")],
    ["refused an update with no reason", "error api", report("unpack ok", "ng refs/heads/main")],
    ["could not unpack the pack", "error parse", report("unpack index-pack abnormal exit")],
    ["reports on another branch alone", "error parse", report("unpack ok", "ok refs/heads/other")],
    ["reports no unpack status", "error parse", report()],
    ["is no pkt-line", "error parse", () => new Response("not a report", { headers: PUSH_RESULT })],
    ["ends inside a pkt-line", "error parse", () => new Response("0032unpack", { headers: PUSH_RESULT })],
    ["is longer than a report", "error parse",
      () => new Response(new Uint8Array(MAX_RECEIVE_PACK_RESPONSE_BYTES + 1), { headers: PUSH_RESULT })],
    ["has no body", "error parse", () => new Response(null, { headers: PUSH_RESULT })],
  ];

  it.each(REPORTS)("sends a push whose answer %s once, and counts it as: %s", async (_name, counted, answer) => {
    const sent = answering(answer);
    await ending(push());
    const [outcome, reason = ""] = counted.split(" ");
    expect(sent.map(({ method, url }) => [method, url])).toEqual([["POST", URL_SENT]]);
    expect(calls()).toEqual([["git.receive-pack", outcome, reason, "", 200]]);
  });

  it.each(REPORTS)("ends a push whose answer %s as the transport ends one handed that answer", async (_name, _counted, answer) => {
    answering(answer);
    const ended = await ending(push());
    expect(ended).toEqual(await ending(pushGitRefUpdate(async () => answer(), UPDATE, packed())));
    // Only an applied update ends a push with nothing.
    expect(ended === undefined).toBe(answer === landed);
  });

  it("throws the refusal of an update as the transport's rejection, with git's reason", async () => {
    answering(report("unpack ok", "ng refs/heads/main pre-receive hook declined"));
    const error = await rejection(push());
    expect(error).toBeInstanceOf(GitRefUpdateRejectedError);
    expect(error).toMatchObject({
      message: "git push rejected for refs/heads/main: pre-receive hook declined",
      reason: "pre-receive hook declined",
    });
  });

  it("counts a push by what the report says of the branch it updates, and of no other", async () => {
    answering(report("unpack ok", "ng refs/heads/main fetch first", "ok refs/heads/feature/x"));
    const answered = await api().fetchGitReceivePack("g/p", "feature/x", packed());
    expect(answered.ok).toBe(true);
    expect(calls()).toEqual([["git.receive-pack", "success", "", "", 200]]);
  });

  it("counts a report whose transfer is cut off as no success, and throws what cut it off", async () => {
    const cut = new Error("connection reset");
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(encodePktLine("unpack ok")),
      pull: controller => controller.error(cut),
    }), { headers: PUSH_RESULT }));
    expect(await rejection(push())).toBe(cut);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", "error", "parse", "", 200]]);
  });

  it("counts a report that the request's timeout cut off as a timeout, and sends no second push", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(encodePktLine("unpack ok")),
      pull: controller => {
        timeout.abort(new DOMException("The operation timed out.", "TimeoutError"));
        controller.error(timeout.signal.reason);
      },
    }), { headers: PUSH_RESULT }));
    expect(await rejection(push())).toMatchObject({ name: "TimeoutError" });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", "error", "timeout", "", 200]]);
  });

  it.each<[number, string, string, string]>([
    [404, "Not Found", "error", "http"],
    [429, "Too Many Requests", "refused", "rate"],
    [503, "Service Unavailable", "error", "http"],
  ])("counts a push answered %i by that status, and throws it with the answer's text", async (status, statusText, outcome, reason) => {
    const sent = answering(() => new Response(" Repository not found.\n", { status, statusText, headers: PUSH_RESULT }));
    const error = await rejection(push());
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error).toMatchObject({ status, message: `git push failed: ${status} ${statusText}: Repository not found.` });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", outcome, reason, "", status]]);
  });

  it("counts a push that is redirected by its status, and throws where it was sent on to", async () => {
    const sent = answering(empty(302, { ...PUSH_RESULT, location: "https://login.example.test/sign-in" }));
    expect(await rejection(push())).toMatchObject({
      name: "GitLabApiError", status: 302, movedTo: "https://login.example.test/sign-in",
      message: expect.stringContaining("git push failed: the git endpoint redirected (https://login.example.test/sign-in)"),
    });
    expect(sent.map(({ init }) => init.redirect)).toEqual(["manual"]);
    expect(calls()).toEqual([["git.receive-pack", "error", "http", "", 302]]);
  });

  it("stops reading a report that has no end once it is longer than a report may be", async () => {
    const chunk = new Uint8Array(4096);
    let pulled = 0;
    let cancelled = false;
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      pull: controller => {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel: () => { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: PUSH_RESULT }));
    expect(await rejection(push())).toMatchObject({
      message: `git push response exceeded the ${MAX_RECEIVE_PACK_RESPONSE_BYTES}-byte limit`,
    });
    // The read ends with the chunk that passes the limit: nothing beyond it is asked for.
    expect(pulled).toBe(MAX_RECEIVE_PACK_RESPONSE_BYTES + chunk.byteLength);
    expect(cancelled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", "error", "parse", "", 200]]);
  });

  it("reads no report from a 200 that is no git result, however long it is", async () => {
    const page = new Uint8Array(MAX_RECEIVE_PACK_RESPONSE_BYTES + 1).fill(0x20);
    let read = false;
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      pull: controller => {
        read = true;
        controller.enqueue(page);
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(await rejection(push())).toMatchObject({
      name: "GitLabApiError", status: 502,
      message: expect.stringContaining("git push failed: expected application/x-git-receive-pack-result but the endpoint answered text/html"),
    });
    expect(read).toBe(false);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", "error", "parse", "", 200]]);
  });

  it.each([200, 202])("answers a push GitLab answered %i with that status and its headers over the report it read, and counts it with it", async status => {
    const lines = new Blob([encodePktLine("unpack ok"), encodePktLine("ok refs/heads/main"), FLUSH_PKT]);
    answering(() => new Response(lines, { status, headers: { ...PUSH_RESULT, "x-request-id": "request-1" } }));
    const answered = await api().fetchGitReceivePack("g/p", "main", packed());
    expect(answered.status).toBe(status);
    expect(Object.fromEntries(answered.headers)).toEqual({ ...PUSH_RESULT, "x-request-id": "request-1" });
    expect(new Uint8Array(await answered.arrayBuffer())).toEqual(new Uint8Array(await lines.arrayBuffer()));
    expect(calls()).toEqual([["git.receive-pack", "success", "", "", status]]);
  });

  it("streams the command and the pack to GitLab as the transport composed them, with the instance's headers", async () => {
    const sent = answering(landed);
    const behindAccess = new GitLabApi(
      { apiOrigin: "https://gitlab-access.example.com", headers: { "CF-Access-Client-Id": "id.access" } },
      async () => "test-token");
    await pushGitRefUpdate(body => behindAccess.fetchGitReceivePack("group/sub/project", "main", body), UPDATE, packed());
    const [{ method, url, init }] = sent;
    expect([method, url, init.redirect])
      .toEqual(["POST", "https://gitlab-access.example.com/group/sub/project.git/git-receive-pack", "manual"]);
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: "application/x-git-receive-pack-result",
      authorization: `Basic ${btoa("oauth2:test-token")}`,
      "cf-access-client-id": "id.access",
      "content-type": "application/x-git-receive-pack-request",
      "user-agent": "Cloudflare-Gadgets",
    });
    // The body is the transport's stream itself, read by `fetch` alone.
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(init.body).text())
      .toBe(`${new TextDecoder().decode(encodePktLine(`${OLD} ${NEW} refs/heads/main\0report-status agent=cloudflare-gadgets`))}0000PACK`);
  });
});

describe("how a job's log is counted, by how the reading of it ends", () => {
  const MIB = 1024 * 1024;
  const encoder = new TextEncoder();
  // A line of 1024 bytes, its newline included.
  const LINE = `${"x".repeat(1023)}\n`;
  // A log as GitLab writes one: a section's coloured heading, two lines, and the section's end.
  const LOG = "section_start:1700000000:build\r\x1b[0K\x1b[36;1mBuilding\x1b[0;m\nline 1\nline 2\nsection_end:1700000001:build\r\x1b[0K";

  it("counts a log read to its end as a success, and answers what its reader keeps of it", async () => {
    const sent = answering(() => new Response(LOG, { headers: { "content-type": "text/plain" } }));

    const log = await trace();

    expect(log).toEqual({ lines: ["▶ Building", "line 1", "line 2"], firstLine: 1, totalLines: 3 });
    expect(log).toEqual(await readCiLog(new Blob([LOG]).stream(), normalizeGitLabLogLine));
    expect(sent.map(({ method, url }) => [method, url])).toEqual([["GET", `${API}projects/g%2Fp/jobs/8/trace`]]);
    expect(calls()).toEqual([["jobs.trace", "success", "", "", 200]]);
  });

  it("counts a log whose transfer is cut off part-way as no success, sent once, and throws what its reader throws", async () => {
    const cut = new TypeError("connection lost");
    // Two lines of a log, and then the failure of its transfer.
    const broken = () => new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(encoder.encode("line 1\nline 2\n")),
      pull: controller => controller.error(cut),
    });
    const sent = answering(() => new Response(broken()));

    expect(await rejection(trace())).toBe(cut);

    expect(await rejection(readCiLog(broken(), normalizeGitLabLogLine))).toBe(cut);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["jobs.trace", "error", "parse", "", 200]]);
  });

  it("counts a log longer than its reader keeps as a success, read a chunk at a time and held to the reader's bound", async () => {
    // 6 MiB of lines in chunks of 64 KiB: more lines than the reader keeps in its 8 MiB of memory.
    const chunk = encoder.encode(LINE.repeat(64));
    const length = 96 * chunk.byteLength;
    // The log, each chunk handed over only once it is asked for, with a count of the bytes handed
    // over, of those split into lines, and of the most that were handed over and not yet split.
    const counting = () => {
      const count = { handed: 0, split: 0, held: 0 };
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (count.handed === length) return controller.close();
          count.handed += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }, { highWaterMark: 0 });
      const normalizeLine = (line: string) => {
        count.held = Math.max(count.held, count.handed - count.split);
        count.split += line.length + 1;
        return normalizeGitLabLogLine(line);
      };
      return { count, stream, normalizeLine };
    };
    const requested = counting();
    const alone = counting();
    const sent = answering(() => new Response(requested.stream));

    const log = await trace(requested.normalizeLine);

    // The tail the reader keeps of that log when it is handed the stream itself.
    expect(log).toEqual(await readCiLog(alone.stream, alone.normalizeLine));
    expect(log).toMatchObject({ firstLine: 2077, totalLines: 6144 });
    expect(log?.lines).toHaveLength(4068);
    // What the lines kept cost, as the reader measures it: two bytes a character and sixteen a line.
    expect(log?.lines.reduce((bytes, line) => bytes + 2 * line.length + 16, 0)).toBeLessThanOrEqual(8 * MIB);
    // A chunk is asked for only once the one before it is split into lines, so one chunk is held
    // beside the lines kept: no more than the reader holds when the stream is its own.
    expect(requested.count).toEqual({ handed: length, split: length, held: chunk.byteLength });
    expect(requested.count).toEqual(alone.count);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["jobs.trace", "success", "", "", 200]]);
  });

  it("stops reading a log longer than its reader takes, counts it as no success, sent once, and throws the reader's refusal", async () => {
    const chunk = encoder.encode(LINE.repeat(1024));
    let handed = 0;
    let cancelled = false;
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      pull: controller => {
        handed += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel: () => { cancelled = true; },
    }, { highWaterMark: 0 })));

    const error = await rejection(trace());

    expect(error).toBeInstanceOf(CiLogTooLargeError);
    expect(error).toMatchObject({ maxBytes: 128 * MIB, message: "The log is larger than 128 MiB and cannot be read." });
    // The read ends with the chunk that passes the limit: nothing beyond it is asked for.
    expect(handed).toBe(128 * MIB + chunk.byteLength);
    expect(cancelled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["jobs.trace", "error", "parse", "", 200]]);
  });

  it("answers a job that has no log as none, counted by its status, and a log with no body as an empty one", async () => {
    const sent = answering(json({ message: "404 Not found" }, { status: 404 }), empty(200));

    expect(await trace()).toBeNull();
    expect(await trace()).toEqual({ lines: [], firstLine: 1, totalLines: 0 });

    expect(sent).toHaveLength(2);
    expect(calls()).toEqual([["jobs.trace", "error", "http", "", 404], ["jobs.trace", "success", "", "", 200]]);
  });
});

describe("which requests are sent again", () => {
  it.each([429, 502, 503, 504])("sends a read answered %i three times, counting each", async status => {
    const sent = answering(json({ message: "unavailable" }, { status }));
    expect(await rejection(api().getIssue("g/p", 3))).toMatchObject({ name: "GitLabApiError", status });
    expect(sent).toHaveLength(3);
    expect(calls()).toEqual(Array.from({ length: 3 }, () =>
      ["issues.get", status === 429 ? "refused" : "error", status === 429 ? "rate" : "http", "", status]));
  });

  it("answers a read whose second attempt succeeds, presenting the token it asked for once", async () => {
    const sent = answering(json({ message: "Bad Gateway" }, { status: 502 }), json({ iid: 3 }));
    const credentials = vi.fn(async () => "test-token");
    expect(await new GitLabApi(INSTANCE, credentials).getIssue("g/p", 3)).toEqual({ iid: 3 });
    expect(sent.map(({ init }) => new Headers(init.headers).get("Authorization")))
      .toEqual(["Bearer test-token", "Bearer test-token"]);
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["issues.get", "error", "http", "", 502], ["issues.get", "success", "", "", 200]]);
  });

  it("sends a read GitLab never answers three times, and reports it as GitLab failing", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("connection reset"); });
    vi.stubGlobal("fetch", fetch);
    expect(await rejection(api().getIssue("g/p", 3))).toMatchObject({
      name: "GitLabApiError", status: 502, message: "GitLab could not be reached: connection reset",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(calls()).toEqual(Array.from({ length: 3 }, () => ["issues.get", "error", "network", "", 0]));
  });

  it("asks again for a read whose answer the timeout cut off, three times at most, and for a write once", async () => {
    const attempts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const attempt = new AbortController();
      attempts.push(attempt);
      return attempt.signal;
    });
    // An answer whose body fails as its attempt's timeout fires.
    const stalled = () => new Response(new ReadableStream({
      pull(controller) {
        const reason = new DOMException("The operation timed out.", "TimeoutError");
        attempts.at(-1)?.abort(reason);
        controller.error(reason);
      },
    }), { headers: { "content-type": "application/json" } });

    const recovered = answering(stalled, json({ iid: 3 }));
    expect(await api().getIssue("g/p", 3)).toEqual({ iid: 3 });
    expect(recovered).toHaveLength(2);
    expect(calls()).toEqual([["issues.get", "error", "timeout", "", 200], ["issues.get", "success", "", "", 200]]);

    const unread = answering(stalled);
    const late = { name: "GitLabApiError", status: 504, message: "GitLab did not answer in time." };
    expect(await rejection(api().getIssue("g/p", 3))).toMatchObject(late);
    expect(unread).toHaveLength(3);
    expect(await rejection(api().createNote("g/p", "issues", 3, "Hello"))).toMatchObject(late);
    expect(unread).toHaveLength(4);
    expect(calls().slice(2)).toEqual([
      ...Array.from({ length: 3 }, () => ["issues.get", "error", "timeout", "", 200]),
      ["notes.create", "error", "timeout", "", 200],
    ]);
  });

  it("asks again for a blob whose transfer the timeout cut off, three times at most, and throws that timeout", async () => {
    const attempts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const attempt = new AbortController();
      attempts.push(attempt);
      return attempt.signal;
    });
    // An answer whose bytes stop as its attempt's timeout fires.
    const stalled = () => new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new Uint8Array(16)),
      pull(controller) {
        const reason = new DOMException("The operation timed out.", "TimeoutError");
        attempts.at(-1)?.abort(reason);
        controller.error(reason);
      },
    }));

    const recovered = answering(stalled, () => new Response("blob"));
    expect(await api().getBlob("g/p", BLOB, 1024)).toEqual(new Uint8Array(new TextEncoder().encode("blob")));
    expect(recovered).toHaveLength(2);

    const unread = answering(stalled);
    const error = await rejection(api().getBlob("g/p", BLOB, 1024));
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "TimeoutError", message: "The operation timed out." });
    expect(unread).toHaveLength(3);
    expect(calls()).toEqual([
      ["blobs.raw", "error", "timeout", "", 200],
      ["blobs.raw", "success", "", "", 200],
      ...Array.from({ length: 3 }, () => ["blobs.raw", "error", "timeout", "", 200]),
    ]);
  });

  it("gives a job's log two minutes in all: one that stalls is asked for once, and throws that timeout", async () => {
    const timers: AbortController[] = [];
    const timeouts = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const timer = new AbortController();
      timers.push(timer);
      return timer.signal;
    });
    // An answer whose log stops after a line as the two minutes run out: those of its attempt and
    // those of the whole request, which began together.
    const stalled = () => new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(new TextEncoder().encode("line 1\n")),
      pull(controller) {
        const reason = new DOMException("The operation timed out.", "TimeoutError");
        for (const timer of timers) timer.abort(reason);
        controller.error(reason);
      },
    }));

    const sent = answering(stalled, () => new Response("line 1\nline 2\n"));
    const error = await rejection(trace());
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "TimeoutError", message: "The operation timed out." });
    expect(sent).toHaveLength(1);
    // The request's two minutes, then its one attempt's.
    expect(timeouts.mock.calls).toEqual([[120_000], [120_000]]);
    expect(calls()).toEqual([["jobs.trace", "error", "timeout", "", 200]]);
  });

  it("asks again for a job's log that an attempt failed to bring within those two minutes", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sent = answering(() => new Response("busy", { status: 503 }), () => new Response("line 1\nline 2\n"));
    expect(await trace()).toEqual({ lines: ["line 1", "line 2"], firstLine: 1, totalLines: 2 });
    expect(sent).toHaveLength(2);
    expect(calls()).toEqual([["jobs.trace", "error", "http", "", 503], ["jobs.trace", "success", "", "", 200]]);
  });

  it("sends a write GitLab never answers once", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("connection reset"); });
    vi.stubGlobal("fetch", fetch);
    expect(await rejection(api().createNote("g/p", "issues", 3, "Hello"))).toMatchObject({ name: "GitLabApiError", status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends a read that fails for a reason of its own once", async () => {
    const sent = answering(json({ message: "500 Internal Server Error" }, { status: 500 }));
    expect(await rejection(api().getIssue("g/p", 3))).toMatchObject({ status: 500 });
    expect(sent).toHaveLength(1);
  });

  it.each<[string, (gitlab: GitLabApi) => Promise<unknown>]>([
    ["a REST create", gitlab => gitlab.createNote("g/p", "issues", 3, "Hello")],
    ["a REST update", gitlab => gitlab.updateIssue("g/p", 3, { title: "t" })],
    ["a REST delete", gitlab => gitlab.deleteNote("g/p", "issues", 3, 9)],
    ["a merge", gitlab => gitlab.mergeMergeRequest("g/p", 5, {})],
    ["a token's exchange", exchange],
    ["a token's refresh", refresh],
    ["a token's revocation", () => revokeToken(INSTANCE, { ...APP, token: "access-token" })],
    ["a git fetch", gitlab => gitlab.fetchGitUploadPack("g/p", new Uint8Array([48, 48, 48, 48]))],
    ["a git push", gitlab => gitlab.fetchGitReceivePack("g/p", "main", new Blob(["0000"]).stream())],
  ])("sends %s once, whatever it is answered", async (_name, send) => {
    const sent = answering(json({ message: "Service Unavailable" }, { status: 503 }));
    expect(await rejection(send(api()))).toMatchObject({ name: "GitLabApiError", status: 503 });
    expect(sent).toHaveLength(1);
  });

  it("gives a git transfer and a job's log two minutes, and any other request the default", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const gitlab = api();

    answering(pack("git-upload-pack"), pack("git-receive-pack"), () => new Response("log"), json({ iid: 3 }), json(GRANT));
    await gitlab.fetchGitUploadPack("g/p", new Uint8Array([48, 48, 48, 48]));
    await gitlab.fetchGitReceivePack("g/p", "main", new Blob(["0000"]).stream());
    await gitlab.getJobTrace("g/p", 8, log => log.cancel());
    await gitlab.getIssue("g/p", 3);
    await exchange();

    // A job's log has its two minutes twice: over the whole request, and over its one attempt.
    expect(timeouts.mock.calls).toEqual([[120_000], [120_000], [120_000], [120_000], [30_000], [30_000]]);
  });
});
