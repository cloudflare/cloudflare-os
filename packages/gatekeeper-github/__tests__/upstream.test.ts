// The requests this gatekeeper makes to GitHub and the name each is counted under, and what the
// gatekeeper decides about a call that the client cannot know: a 304 to a conditional read and a
// redirect it acts on are successes, a rate limit comes as a 403 or inside
// a GraphQL 200, git reports a refused push inside a 200, an answer that the API client throws
// on is an error whatever its status, a job's log is counted by the reading of it, and which
// requests are sent again.

import { env } from "cloudflare:workers";
import { CiLogTooLargeError, readCiLog } from "@gadgets/gatekeeper-kit/ci";
import {
  encodePktLine, FLUSH_PKT, GitRefUpdateRejectedError, MAX_RECEIVE_PACK_RESPONSE_BYTES, pushGitRefUpdate,
} from "@gadgets/gatekeeper-kit/git-transport";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthCode, GitHubApi, GitHubApiError, revokeOAuthToken } from "../src/github-api";
import { normalizeGitHubLogLine } from "../src/github-ci";
import {
  API_BASE_URL as API, GITHUB_OPERATIONS, GITHUB_ROUTES, githubUpstream, type GitHubOperation,
} from "../src/github-upstream";

type Row = [method: string, url: string, name: string];

/** Every kind of request made beneath a repository, by its path there, with the name it is counted under. */
const REPOSITORY_REQUESTS: [method: string, path: string, name: string][] = [
  ["GET", "/issues?state=open&per_page=100&page=1", "issues.list"],
  ["POST", "/issues", "issues.create"],
  ["GET", "/issues/5", "issues.get"],
  ["PATCH", "/issues/5", "issues.patch"],
  ["GET", "/issues/5/comments?page=1&per_page=100", "comments.list"],
  ["POST", "/issues/5/comments", "comments.create"],
  ["PATCH", "/issues/comments/9", "comments.patch"],
  ["DELETE", "/issues/comments/9", "comments.delete"],
  ["POST", "/issues/5/labels", "labels.create"],
  ["PUT", "/issues/5/labels", "labels.update"],
  ["DELETE", "/issues/5/labels/good%20first%20issue", "labels.delete"],
  ["GET", "/pulls?state=open&per_page=100&page=1", "pulls.list"],
  ["POST", "/pulls", "pulls.create"],
  ["GET", "/pulls/7", "pulls.get"],
  ["PUT", "/pulls/7/merge", "pulls.merge"],
  ["GET", "/pulls/7/reviews?page=1&per_page=100", "reviews.list"],
  ["POST", "/pulls/7/reviews", "reviews.create"],
  ["PUT", "/pulls/7/reviews/3", "reviews.update"],
  ["GET", "/pulls/7/comments?page=1&per_page=100", "comments.list"],
  ["POST", "/pulls/7/comments/9/replies", "replies.create"],
  ["GET", "/pulls/comments/9", "comments.get"],
  ["PATCH", "/pulls/comments/9", "comments.patch"],
  ["DELETE", "/pulls/comments/9", "comments.delete"],
  ["GET", "/pulls/7/files?page=1&per_page=100", "files.list"],
  ["GET", "/pulls/7/commits?page=1&per_page=100", "commits.list"],
  ["GET", "/commits?sha=main&per_page=100&page=1", "commits.list"],
  ["GET", "/commits/feature%2Fthing", "commits.get"],
  ["GET", "/compare/main...feature%2Fthing", "compare.get"],
  ["GET", "/branches?per_page=100&page=1", "branches.list"],
  ["GET", "/branches/release/1.0", "branches.get"],
  ["GET", "/tags?per_page=100&page=1", "tags.list"],
  ["GET", "/git/ref/heads/release/1.0", "ref.get"],
  ["GET", "/git/trees/4b825dc642cb6eb9a060e54bf8d69288fbee4904", "trees.get"],
  ["GET", "/git/blobs/e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "blobs.get"],
  ["GET", "/rules/branches/release/1.0?per_page=100", "rules.get"],
  ["GET", "/activity?ref=refs%2Fheads%2Fmain&direction=desc&per_page=30", "activity.list"],
  ["GET", "/check-runs/11", "check-runs.get"],
  ["GET", "/check-runs/11/annotations?page=1&per_page=100", "annotations.list"],
  ["GET", "/actions/jobs/21", "jobs.get"],
  ["GET", "/actions/jobs/21/logs", "logs.get"],
  ["GET", "/actions/runs?page=1&per_page=100&exclude_pull_requests=true", "runs.list"],
  ["GET", "/actions/runs/31?exclude_pull_requests=true", "runs.get"],
  ["GET", "/actions/runs/31/jobs?page=1&per_page=100&filter=latest", "jobs.list"],
  ["GET", "/actions/runs/31/attempts/2/jobs?page=1&per_page=100", "jobs.list"],
];

/**
 * Every kind of request the gatekeeper makes under the API's root. One beneath a repository is
 * made by its name and, for a pinned repository, by its id.
 */
const REQUESTS: Row[] = [
  ["GET", `${API}/user`, "user.get"],
  ["GET", `${API}/user/emails`, "emails.list"],
  ["GET", `${API}/user/repos?per_page=100&page=1`, "repos.list"],
  ["GET", `${API}/search/repositories?q=gadgets&per_page=30&page=1`, "search.repositories"],
  ["GET", `${API}/search/issues?q=repo%3Aocto%2Frepo&advanced_search=true&page=1&per_page=100`, "search.issues"],
  ["GET", `${API}/repos/octo/repo`, "repos.get"],
  ["GET", `${API}/repositories/42`, "repositories.get"],
  ["GET", `${API}/repositories/42/hooks?per_page=100&page=1`, "hooks.list"],
  ["POST", `${API}/repositories/42/hooks`, "hooks.create"],
  ["GET", `${API}/repositories/42/hooks/100`, "hooks.get"],
  ["PATCH", `${API}/repositories/42/hooks/100`, "hooks.patch"],
  ["DELETE", `${API}/repositories/42/hooks/100`, "hooks.delete"],
  ["GET", `${API}/repositories/42/hooks/100/deliveries?per_page=100`, "deliveries.list"],
  ["POST", `${API}/repositories/42/hooks/100/deliveries/5/attempts`, "attempts.create"],
  ...REPOSITORY_REQUESTS.flatMap(([method, path, name]): Row[] => [
    [method, `${API}/repos/octo/repo${path}`, name],
    [method, `${API}/repositories/42${path}`, name],
  ]),
];

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

// What a rejection is: its class, its message and, of a GitHubApiError, its status.
function thrownAs(error: unknown): unknown[] {
  return error instanceof Error
    ? [error.constructor, error.message, ...(error instanceof GitHubApiError ? [error.status] : [])] : [error];
}

const api = () => new GitHubApi(async () => "test-token");
// The API as one account, with the repository `octo/repo` pinned by its id.
const pinned = () => new GitHubApi(async () => "test-token", { repo: { owner: "octo", repo: "repo", id: 42 } });
const query = () => api().graphql("graphql.deployment.get", "query { node }", { id: "CR_1" });
const checks = (github: GitHubApi) =>
  github.queryRepository("graphql.checks.list", "octo", "repo", "query { repository }", {});
// Reads a downloaded log as its text.
const text = (log: ReadableStream<Uint8Array>) => new Response(log).text();
// Reads a downloaded log as the gatekeeper does: with the kit's bounded reader, over GitHub's lines.
const reading = (log: ReadableStream<Uint8Array>) => readCiLog(log, normalizeGitHubLogLine);
// What the gatekeeper keeps of one line of a long log, its number and some text, and that line as
// GitHub stores it, behind a timestamp.
const keptOf = (line: number) => `${String(line).padStart(8, "0")} ${"x".repeat(120)}`;
const numbered = (line: number) => `2026-01-01T00:00:00.0000000Z ${keptOf(line)}\n`;
// An answer with the status of a success that is no JSON.
const html = () => new Response("<html>Bad gateway</html>", { headers: { "content-type": "text/html" } });

// The content types git answers a fetch and a push with: that of a pack, and that of a report.
const PACK_RESULT = { "content-type": "application/x-git-upload-pack-result" };
const PUSH_RESULT = { "content-type": "application/x-git-receive-pack-result" };
// An upload-pack's answer: a 200 that says it is a pack.
const packed = () => new Response("0000", { headers: PACK_RESULT });
// A receive-pack's answer: a 200 whose body is the report-status of these lines.
const report = (...lines: string[]) => () =>
  new Response(new Blob([...lines.map(encodePktLine), FLUSH_PKT]), { headers: PUSH_RESULT });
const landed = report("unpack ok", "ok refs/heads/main");
const pack = () => new Blob(["PACK"]).stream();

describe("the names of GitHub's requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(githubUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(GITHUB_ROUTES)).toHaveLength(49);
    expect(unreachedRouteEnds(GITHUB_ROUTES, REQUESTS)).toEqual([]);
  });

  it.each<Row>([
    ["GET", `${API}/orgs/octo/repos`, "GET"],
    ["PUT", `${API}/repos/octo/repo/issues/5/lock`, "PUT"],
    ["GET", `${API}/repos/octo/repo/hooks`, "GET"],
    ["POST", `${API}/graphql`, "POST"],
    ["POST", "https://github.com/octo/repo.git/git-upload-pack", "POST"],
    ["GET", "https://storage.example/logs/21?sig=secret", "GET"],
  ])("names %s %s, which no path of the tree is, by its method", (method, url, name) => {
    expect(githubUpstream.operationOf(method, url)).toBe(name);
  });

  it("counts every request under the source of the vendor and the service github", async () => {
    answering(json({ login: "octocat" }));
    await api().getViewerConditional();
    expect(githubUpstream.source).toBe("gatekeeper.github.api");
    expect(points.map(point => [
      column(point, SUBSERVICE_V1_SLOTS.source), column(point, SUBSERVICE_V1_SLOTS.service),
      column(point, SUBSERVICE_V1_SLOTS.operation),
    ])).toEqual([["gatekeeper.github.api", "github", "user.get"]]);
  });
});

describe("the requests no path names", () => {
  // Each literal name, with the call that sends the request it names and the answer it is given.
  const LITERALS = {
    "graphql.checks.list": {
      status: 200,
      answer: json({ data: { repository: { databaseId: 42 } } }),
      send: () => api().queryRepository("graphql.checks.list", "octo", "repo", "query { repository }", {}),
    },
    "graphql.deployment.get": {
      status: 200,
      answer: json({ data: { node: null } }),
      send: () => api().graphql("graphql.deployment.get", "query { node }", { id: "CR_1" }),
    },
    "token.revoke": {
      status: 204,
      answer: empty(204),
      send: () => revokeOAuthToken("gho_token", "client-id", "client-secret"),
    },
    "logs.download": {
      status: 200,
      answer: () => new Response("log"),
      send: () => api().downloadJobLog("https://storage.example/logs/21?sig=secret", log => log.cancel()),
    },
    "git.upload-pack": {
      status: 200,
      answer: packed,
      send: () => api().fetchGitUploadPack("octo", "repo", new Uint8Array([48, 48, 48, 48])),
    },
    "git.receive-pack": {
      status: 200,
      answer: landed,
      send: () => api().fetchGitReceivePack("octo", "repo", "main", pack()),
    },
  } satisfies Record<GitHubOperation, { status: number; answer: () => Response; send: () => Promise<unknown> }>;

  it("sends a request for every literal name, and lists none twice", () => {
    expect(Object.keys(LITERALS).toSorted()).toEqual(GITHUB_OPERATIONS.toSorted());
    expect(new Set(GITHUB_OPERATIONS).size).toBe(GITHUB_OPERATIONS.length);
  });

  it.each(Object.entries(LITERALS))("counts a request under %s", async (name, { status, answer, send }) => {
    const sent = answering(answer);
    await send();
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([[name, "success", "", "", status]]);
  });

  it("counts a token's exchange through the OAuth client", async () => {
    const sent = answering(json({ access_token: "gho_token", scope: "repo,user:email", token_type: "bearer" }));
    await exchangeAuthCode("code", "client-id", "client-secret", "https://gadgets.example/oauth");
    expect(sent.map(({ method, url }) => [method, url])).toEqual([["POST", "https://github.com/login/oauth/access_token"]]);
    expect(calls()).toEqual([["token.exchange", "success", "", "", 200]]);
  });
});

describe("how GitHub's answers are counted", () => {
  it("counts a conditional read answered 304 as a success", async () => {
    answering(empty(304));
    expect(await api().getIssueConditional("octo", "repo", 5, { ifNoneMatch: "\"etag\"" })).toMatchObject({ status: 304 });
    expect(calls()).toEqual([["issues.get", "success", "", "", 304]]);
  });

  it.each<[string, string, () => Promise<{ status: number }>]>([
    ["of an issue that is given no options", "issues.get", () => api().getIssueConditional("octo", "repo", 5)],
    ["of an issue whose options name no version", "issues.get",
      () => api().getIssueConditional("octo", "repo", 5, { ifNoneMatch: undefined })],
    ["of a listing of branches", "branches.list",
      () => api().listBranchesConditional("octo", "repo", { per_page: 100, page: 1 })],
    ["of a search", "search.issues", () => api().searchIssuesConditional("repo:octo/repo", 1, 100)],
  ])("counts a conditional read %s as a success where it is answered 304, which it answers with", async (_what, name, read) => {
    const sent = answering(empty(304));
    expect(await read()).toMatchObject({ status: 304 });
    expect(sent).toHaveLength(1);
    expect(new Headers(sent[0].init.headers).has("If-None-Match")).toBe(false);
    expect(calls()).toEqual([[name, "success", "", "", 304]]);
  });

  it.each([
    ["its primary limit's header", { "x-ratelimit-remaining": "0" }, "API rate limit exceeded"],
    ["its secondary limit's header", { "retry-after": "60" }, "You have exceeded a secondary rate limit"],
    ["its message alone", {}, "You have exceeded a secondary rate limit. Please wait."],
  ])("counts a 403 that is a rate limit by %s as a refusal", async (_name, headers, message) => {
    const sent = answering(json({ message }, { status: 403, headers }));
    expect(await rejection(api().getIssue("octo", "repo", 5))).toMatchObject({ status: 403, rateLimited: true });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["issues.get", "refused", "rate", "", 403]]);
  });

  it.each<[string, () => Response]>([
    ["an empty body", () => new Response("", { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" } })],
    ["a body that is no JSON", () => new Response("{", { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" } })],
  ])("counts a 403 that its headers mark a rate limit as a refusal where it holds %s", async (_name, answer) => {
    const sent = answering(answer);
    expect(await rejection(api().getViewer())).toMatchObject({ name: "GitHubApiError", status: 403, rateLimited: true });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["user.get", "refused", "rate", "", 403]]);
  });

  it("throws what reading a 403 failed with where its headers mark no rate limit, a denial it cannot be", async () => {
    const sent = answering(() => new Response("{", { status: 403, headers: { "content-type": "application/json" } }));
    const thrown = await rejection(api().getViewer());
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(sent).toHaveLength(1);
    // Counted by its status, as a failure that was no throttle.
    expect(calls()).toEqual([["user.get", "error", "http", "", 403]]);
  });

  it("counts a 403 that is no rate limit, and a 404 the caller reads as an answer, by their status", async () => {
    answering(json({ message: "Resource not accessible" }, { status: 403, headers: { "x-ratelimit-remaining": "20" } }),
      json({ message: "Not Found" }, { status: 404 }));
    expect(await rejection(api().getIssue("octo", "repo", 5))).toMatchObject({ status: 403, rateLimited: false });
    await api().deleteRepoWebhook(42, 100);
    expect(calls()).toEqual([["issues.get", "error", "http", "", 403], ["hooks.delete", "error", "http", "", 404]]);
  });

  it("counts a GraphQL answer by the errors its 200 carries", async () => {
    answering(
      json({ data: { node: null } }),
      json({ data: { node: null }, errors: [{ message: "timeout", path: ["node"] }] }),
      json({ data: null, errors: [{ message: "Could not resolve to a node", type: "NOT_FOUND" }] }),
      json({ errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }] }),
    );

    expect(await query()).toEqual({ data: { node: null }, errors: [] });
    expect((await query()).errors).toHaveLength(1);
    expect(await rejection(query())).toMatchObject({ name: "GitHubApiError", status: 404 });
    expect(await rejection(query())).toMatchObject({ name: "GitHubApiError", status: 502 });
    expect(calls()).toEqual([
      ["graphql.deployment.get", "success", "", "", 200],
      ["graphql.deployment.get", "error", "api", "partial", 200],
      ["graphql.deployment.get", "error", "api", "", 200],
      ["graphql.deployment.get", "refused", "rate", "", 200],
    ]);
  });

  it("counts a renamed repository's redirect that is re-issued as a success, and the request it is re-issued as", async () => {
    const sent = answering(empty(301, { location: `${API}/repositories/42` }), json({ id: 42 }));
    await api().getRepo("octo", "repo");
    expect(sent.map(({ url }) => url)).toEqual([`${API}/repos/octo/repo`, `${API}/repositories/42`]);
    expect(calls()).toEqual([["repos.get", "success", "", "", 301], ["repositories.get", "success", "", "", 200]]);
  });

  it("counts a redirect that is refused as an error", async () => {
    const sent = answering(empty(301, { location: `${API}/repositories/43/issues/5` }));
    expect(await rejection(api().getIssue("octo", "repo", 5))).toMatchObject({ name: "GitHubApiError", status: 301 });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["issues.get", "error", "http", "", 301]]);
  });

  it("counts a job log's hand-off to storage as a success, and its download under a name of its own", async () => {
    const location = "https://storage.example/logs/21?sig=secret";
    const sent = answering(empty(302, { location }), () => new Response("log"));
    const github = api();
    expect(await github.getWorkflowJobLogLocation("octo", "repo", 21)).toBe(location);
    expect(await github.downloadJobLog(location, text)).toBe("log");

    expect(sent.map(({ url }) => url)).toEqual([`${API}/repos/octo/repo/actions/jobs/21/logs`, location]);
    // The token goes to the API alone.
    expect(sent.map(({ init }) => new Headers(init.headers).get("Authorization"))).toEqual(["Bearer test-token", null]);
    expect(calls()).toEqual([["logs.get", "success", "", "", 302], ["logs.download", "success", "", "", 200]]);
  });

  it("follows no redirect from the storage a log is downloaded from", async () => {
    const sent = answering(empty(302, { location: "https://elsewhere.example/log" }));
    expect(await rejection(api().downloadJobLog("https://storage.example/logs/21?sig=secret", text)))
      .toMatchObject({ name: "GitHubApiError", status: 302 });
    expect(sent.map(({ init }) => init.redirect)).toEqual(["manual"]);
    expect(calls()).toEqual([["logs.download", "error", "http", "", 302]]);
  });
});

describe("how an answer that the API client rejects is counted", () => {
  const storage = "https://storage.example/logs/21?sig=secret";
  const SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  // What the runtime throws on base64 that is none.
  const undecodable = (() => {
    try {
      return atob("%");
    } catch (error) {
      return error;
    }
  })();

  // What a listing of workflow runs, and one of a run's jobs, throws on an answer that holds no list.
  const NO_RUNS_LISTED = [GitHubApiError, "GitHub answered a listing of workflow runs with no list.", 502];
  const NO_JOBS_LISTED = [GitHubApiError, "GitHub answered a listing of a workflow run's jobs with no list.", 502];

  type Rejected = [
    name: string, send: () => Promise<unknown>, answer: () => Response, thrown: unknown[],
    point: (string | number)[],
  ];

  // Each answer GitHub may give with the status of a success that the method which asked for it
  // throws on, with what that method throws and the point its one request is counted as.
  const REJECTED: Rejected[] = [
    ["a GraphQL answer with neither data nor errors", query, json({}),
      [GitHubApiError, "GitHub GraphQL query failed: no data", 502], ["graphql.deployment.get", "error", "api", "", 200]],
    ["a GraphQL answer whose data is null", query, json({ data: null }),
      [GitHubApiError, "GitHub GraphQL query failed: no data", 502], ["graphql.deployment.get", "error", "api", "", 200]],
    ["a GraphQL answer with no data and an empty list of errors", query, json({ errors: [] }),
      [GitHubApiError, "GitHub GraphQL query failed: no data", 502], ["graphql.deployment.get", "error", "api", "", 200]],
    ["a GraphQL answer that is a page of HTML", query, html,
      [GitHubApiError, "GitHub GraphQL query failed: no data", 502], ["graphql.deployment.get", "error", "api", "", 200]],
    ["a GraphQL answer that is the JSON null", query, json(null),
      [TypeError, "Cannot read properties of null (reading 'errors')"], ["graphql.deployment.get", "error", "api", "", 200]],
    ["a GraphQL answer with no data that lists what is no error", query, json({ errors: [null] }),
      [TypeError, "Cannot read properties of null (reading 'message')"], ["graphql.deployment.get", "error", "api", "", 200]],
    ["a GraphQL answer whose repository is null", () => checks(api()), json({ data: { repository: null } }),
      [GitHubApiError, "Repository octo/repo was not found.", 404], ["graphql.checks.list", "error", "api", "", 200]],
    ["a GraphQL answer that names no repository, asked of a pinned one", () => checks(pinned()), json({ data: {} }),
      [TypeError, "Cannot read properties of undefined (reading 'databaseId')"],
      ["graphql.checks.list", "error", "api", "", 200]],

    ["a 304 to an unconditional read", () => api().getIssue("octo", "repo", 5), empty(304),
      [Error, "GitHub unexpectedly returned 304 for an unconditional issue request."], ["issues.get", "error", "http", "", 304]],
    ["a 304 to an unconditional search, whose items are read of a body",
      () => api().searchIssues("repo:octo/repo", 1, 100), empty(304),
      [Error, "GitHub unexpectedly returned 304 for an unconditional issue search request."],
      ["search.issues", "error", "http", "", 304]],
    ["a 304 to a write", () => api().createIssueComment("octo", "repo", 5, "Hello"), empty(304),
      [GitHubApiError, "304 ", 304], ["comments.create", "error", "http", "", 304]],
    ["a 304 to the download of a log", () => api().downloadJobLog(storage, text), empty(304),
      [GitHubApiError, "Downloading the log failed: 304 ", 304], ["logs.download", "error", "http", "", 304]],
    ["a 304 to a git fetch", () => api().fetchGitUploadPack("octo", "repo", new Uint8Array([48, 48, 48, 48])), empty(304),
      [GitHubApiError, "git fetch failed: 304 ", 304], ["git.upload-pack", "error", "http", "", 304]],
    ["a 304 to a git push", () => api().fetchGitReceivePack("octo", "repo", "main", pack()), empty(304),
      [GitHubApiError, "git push failed: 304 ", 304], ["git.receive-pack", "error", "http", "", 304]],

    ["a 200 where a job's log is handed off by a redirect", () => api().getWorkflowJobLogLocation("octo", "repo", 21), json({}),
      [GitHubApiError, "GitHub did not hand off the log of job 21 for download.", 200], ["logs.get", "error", "api", "", 200]],
    ["a 204 where a job's log is handed off by a redirect", () => api().getWorkflowJobLogLocation("octo", "repo", 21), empty(204),
      [GitHubApiError, "GitHub did not hand off the log of job 21 for download.", 204], ["logs.get", "error", "api", "", 204]],
    ["a log's download that has no body", () => api().downloadJobLog(storage, text), () => new Response(null),
      [GitHubApiError, "Downloading the log failed: 200 ", 200], ["logs.download", "error", "parse", "", 200]],

    ["a list of emails that is no list", () => api().getPrimaryVerifiedEmail(), json({}),
      [TypeError, "emails.find is not a function"], ["emails.list", "error", "api", "", 200]],
    ["a repository search with no body to read", () => api().searchRepos({ q: "gadgets", per_page: 30, page: 1 }), json(null),
      [TypeError, "Cannot read properties of null (reading 'items')"], ["search.repositories", "error", "api", "", 200]],
    ["an issue search with no body to read", () => api().searchIssues("repo:octo/repo", 1, 100), json(null),
      [TypeError, "Cannot read properties of null (reading 'items')"], ["search.issues", "error", "api", "", 200]],
    ["a branch's activity that is no list", () => api().listBranchActivity("octo", "repo", "main"), json({}),
      [GitHubApiError, "GitHub answered a listing of branch activity with no list.", 502], ["activity.list", "error", "api", "", 200]],
    ["the repositories of the user that are no list", () => api().listRepos({ per_page: 30, page: 1 }), json({}),
      [GitHubApiError, "GitHub answered a listing of repositories with no list.", 502], ["repos.list", "error", "api", "", 200]],
    ["a repository's issues that are no list", () => api().listIssuesConditional("octo", "repo", { per_page: 30, page: 1 }), json({}),
      [GitHubApiError, "GitHub answered a listing of issues with no list.", 502], ["issues.list", "error", "api", "", 200]],
    ["a repository's pull requests that are no list", () => api().listPullRequestsConditional("octo", "repo", { per_page: 30, page: 1 }), json({}),
      [GitHubApiError, "GitHub answered a listing of pull requests with no list.", 502], ["pulls.list", "error", "api", "", 200]],
    ["a repository search with no list of items", () => api().searchRepos({ q: "gadgets", per_page: 30, page: 1 }),
      json({ total_count: 0 }), [GitHubApiError, "GitHub answered a listing of repositories with no list.", 502],
      ["search.repositories", "error", "api", "", 200]],
    ["an issue search with no list of items", () => api().searchIssues("repo:octo/repo", 1, 100), json({ total_count: 0 }),
      [GitHubApiError, "GitHub answered a listing of issues with no list.", 502], ["search.issues", "error", "api", "", 200]],
    ["a conditional issue search with no list of items", () => api().searchIssuesConditional("repo:octo/repo", 1, 100),
      json({ total_count: 0 }), [GitHubApiError, "GitHub answered a listing of issues with no list.", 502],
      ["search.issues", "error", "api", "", 200]],
    ["a list of webhooks that is no list", () => api().listRepoWebhooks(42), json({}),
      [TypeError, "Spread syntax requires ...iterable[Symbol.iterator] to be a function"],
      ["hooks.list", "error", "api", "", 200]],
    ["a list of deliveries that is no list", () => api().listRepoWebhookDeliveries(42, 100, 0), json({}),
      [TypeError, "data.filter is not a function"], ["deliveries.list", "error", "api", "", 200]],
    ["a branch's ref that names no commit", () => api().getBranchHead("octo", "repo", "main"), json({}),
      [TypeError, "Cannot read properties of undefined (reading 'sha')"], ["ref.get", "error", "api", "", 200]],
    ["a branch with no body to read, asked whether it is protected", () => api().isBranchProtected("octo", "repo", "main"), json(null),
      [TypeError, "Cannot read properties of null (reading 'protected')"], ["branches.get", "error", "api", "", 200]],
    ["a branch with no body to read, asked for its required checks", () => api().getBranchProtectionChecks("octo", "repo", "main"), json(null),
      [TypeError, "Cannot read properties of null (reading 'protection')"], ["branches.get", "error", "api", "", 200]],
    ["a blob with no content", () => api().getGitBlob("octo", "repo", SHA, 100), json({ size: 1, encoding: "base64" }),
      [TypeError, "Cannot read properties of undefined (reading 'replace')"], ["blobs.get", "error", "api", "", 200]],
    ["a blob whose content is no base64", () => api().getGitBlob("octo", "repo", SHA, 100),
      json({ size: 1, encoding: "base64", content: "%" }), thrownAs(undecodable), ["blobs.get", "error", "api", "", 200]],
    ["a list of workflow runs with no body to read", () => api().listWorkflowRuns("octo", "repo", { page: 1, per_page: 100 }), json(null),
      [TypeError, "Cannot read properties of null (reading 'workflow_runs')"], ["runs.list", "error", "api", "", 200]],
    ["a list of a run's jobs with no body to read", () => api().listWorkflowRunJobs("octo", "repo", 31, undefined, 1, 100), json(null),
      [TypeError, "Cannot read properties of null (reading 'jobs')"], ["jobs.list", "error", "api", "", 200]],
    ["a list of workflow runs that counts none and holds no list", () => api().listWorkflowRuns("octo", "repo", { page: 1, per_page: 100 }),
      json({ total_count: 0 }), NO_RUNS_LISTED, ["runs.list", "error", "api", "", 200]],
    ["a list of workflow runs whose list is null", () => api().listWorkflowRuns("octo", "repo", { page: 1, per_page: 100 }),
      json({ total_count: 0, workflow_runs: null }), NO_RUNS_LISTED, ["runs.list", "error", "api", "", 200]],
    ["a list of workflow runs whose list is one run", () => api().listWorkflowRuns("octo", "repo", { page: 1, per_page: 100 }),
      json({ total_count: 1, workflow_runs: { id: 31 } }), NO_RUNS_LISTED, ["runs.list", "error", "api", "", 200]],
    ["a list of a run's jobs that counts none and holds no list", () => api().listWorkflowRunJobs("octo", "repo", 31, undefined, 1, 100),
      json({ total_count: 0 }), NO_JOBS_LISTED, ["jobs.list", "error", "api", "", 200]],
    ["a list of the jobs of a run's attempt that counts none and holds no list", () => api().listWorkflowRunJobs("octo", "repo", 31, 2, 1, 100),
      json({ total_count: 0 }), NO_JOBS_LISTED, ["jobs.list", "error", "api", "", 200]],
    ["a list of a run's jobs whose list is null", () => api().listWorkflowRunJobs("octo", "repo", 31, undefined, 1, 100),
      json({ total_count: 0, jobs: null }), NO_JOBS_LISTED, ["jobs.list", "error", "api", "", 200]],
  ];

  it.each(REJECTED)("counts %s as an error with the status GitHub gave, sends the request once, and throws what its method throws", async (_name, send, answer, thrown, point) => {
    const sent = answering(answer);
    expect(thrownAs(await rejection(send()))).toEqual(thrown);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([point]);
  });

  it("throws base64 that is none as the runtime does", () => {
    expect(thrownAs(undecodable)).toEqual([DOMException, expect.stringMatching(/\S/)]);
  });

  type Accepted = [
    name: string, send: () => Promise<unknown>, answer: () => Response, returned: unknown, point: (string | number)[],
  ];

  // Each of those requests answered with what it was sent for, or with an answer its method reads
  // as one, with what the method returns and the point the request is counted as.
  const ACCEPTED: Accepted[] = [
    ["a GraphQL answer about the pinned repository", () => checks(pinned()), json({ data: { repository: { databaseId: 42 } } }),
      { data: { repository: { databaseId: 42 } }, errors: [] }, ["graphql.checks.list", "success", "", "", 200]],
    ["a GraphQL answer about a repository that is not pinned", () => checks(api()), json({ data: { repository: { databaseId: 43 } } }),
      { data: { repository: { databaseId: 43 } }, errors: [] }, ["graphql.checks.list", "success", "", "", 200]],
    ["a job's log that is gone, answered 404", () => api().getWorkflowJobLogLocation("octo", "repo", 21),
      json({ message: "Not Found" }, { status: 404 }), null, ["logs.get", "error", "http", "", 404]],
    ["a job's log that is gone, answered 410", () => api().getWorkflowJobLogLocation("octo", "repo", 21),
      json({ message: "Gone" }, { status: 410 }), null, ["logs.get", "error", "http", "", 410]],
    ["a list of emails with a primary, verified one", () => api().getPrimaryVerifiedEmail(),
      json([{ email: "old@example.com", primary: false, verified: true }, { email: "octo@example.com", primary: true, verified: true }]),
      "octo@example.com", ["emails.list", "success", "", "", 200]],
    ["a list of emails with none that is verified", () => api().getPrimaryVerifiedEmail(),
      json([{ email: "octo@example.com", primary: true, verified: false }]), null, ["emails.list", "success", "", "", 200]],
    ["no list of emails at all", () => api().getPrimaryVerifiedEmail(), empty(204), null, ["emails.list", "success", "", "", 204]],
    ["a repository search", () => api().searchRepos({ q: "gadgets", per_page: 30, page: 1 }), json({ items: [{ id: 42 }] }),
      [{ id: 42 }], ["search.repositories", "success", "", "", 200]],
    ["an issue search", () => api().searchIssues("repo:octo/repo", 1, 100), json({ items: [{ number: 5 }] }),
      [{ number: 5 }], ["search.issues", "success", "", "", 200]],
    ["a conditional issue search", () => api().searchIssuesConditional("repo:octo/repo", 1, 100), json({ items: [{ number: 5 }] }),
      expect.objectContaining({ status: 200, data: { items: [{ number: 5 }] } }), ["search.issues", "success", "", "", 200]],
    ["a list of webhooks", () => api().listRepoWebhooks(42), json([{ id: 100 }, { id: 101 }]),
      [{ id: 100 }, { id: 101 }], ["hooks.list", "success", "", "", 200]],
    ["a list of deliveries, of which one is recent", () => api().listRepoWebhookDeliveries(42, 100, Date.parse("2026-01-02T00:00:00Z")),
      json([{ id: 2, delivered_at: "2026-01-03T00:00:00Z" }, { id: 1, delivered_at: "2026-01-01T00:00:00Z" }]),
      [{ id: 2, delivered_at: "2026-01-03T00:00:00Z" }], ["deliveries.list", "success", "", "", 200]],
    ["a branch's ref", () => api().getBranchHead("octo", "repo", "main"), json({ object: { sha: SHA } }),
      SHA, ["ref.get", "success", "", "", 200]],
    ["a protected branch", () => api().isBranchProtected("octo", "repo", "main"), json({ name: "main", protected: true }),
      true, ["branches.get", "success", "", "", 200]],
    ["a branch with no flag for its protection", () => api().isBranchProtected("octo", "repo", "main"), json({ name: "main" }),
      false, ["branches.get", "success", "", "", 200]],
    ["a branch's required checks", () => api().getBranchProtectionChecks("octo", "repo", "main"),
      json({ protection: { required_status_checks: { contexts: ["ci"] } } }), { contexts: ["ci"] }, ["branches.get", "success", "", "", 200]],
    ["a branch with no protection", () => api().getBranchProtectionChecks("octo", "repo", "main"), json({ name: "main" }),
      undefined, ["branches.get", "success", "", "", 200]],
    ["a blob", () => api().getGitBlob("octo", "repo", SHA, 100), json({ size: 2, encoding: "base64", content: "aG\nk=\n" }),
      new Uint8Array([104, 105]), ["blobs.get", "success", "", "", 200]],
    ["a blob that is larger than is read", () => api().getGitBlob("octo", "repo", SHA, 1), json({ size: 2, encoding: "base64", content: "aGk=" }),
      "oversized", ["blobs.get", "success", "", "", 200]],
    ["a blob GitHub does not inline", () => api().getGitBlob("octo", "repo", SHA, 100), json({ size: 2, encoding: "none", content: "" }),
      "oversized", ["blobs.get", "success", "", "", 200]],
    ["a blob GitHub does not have", () => api().getGitBlob("octo", "repo", SHA, 100), json({ message: "Not Found" }, { status: 404 }),
      null, ["blobs.get", "error", "http", "", 404]],
    ["a list of workflow runs", () => api().listWorkflowRuns("octo", "repo", { page: 1, per_page: 100 }), json({ workflow_runs: [{ id: 31 }] }),
      [{ id: 31 }], ["runs.list", "success", "", "", 200]],
    ["a list of a run's jobs", () => api().listWorkflowRunJobs("octo", "repo", 31, undefined, 1, 100), json({ jobs: [{ id: 21 }] }),
      [{ id: 21 }], ["jobs.list", "success", "", "", 200]],
    ["a list of workflow runs with none on its page", () => api().listWorkflowRuns("octo", "repo", { page: 1, per_page: 100 }),
      json({ total_count: 0, workflow_runs: [] }), [], ["runs.list", "success", "", "", 200]],
    ["a list of a run's jobs with none on its page", () => api().listWorkflowRunJobs("octo", "repo", 31, undefined, 1, 100),
      json({ total_count: 0, jobs: [] }), [], ["jobs.list", "success", "", "", 200]],
    ["a list of the jobs of a run's attempt", () => api().listWorkflowRunJobs("octo", "repo", 31, 2, 1, 100),
      json({ total_count: 1, jobs: [{ id: 21 }] }), [{ id: 21 }], ["jobs.list", "success", "", "", 200]],
  ];

  it.each(ACCEPTED)("counts %s by its status, and returns what its method reads of it", async (_name, send, answer, returned, point) => {
    const sent = answering(answer);
    expect(await send()).toEqual(returned);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([point]);
  });

  it("counts a GraphQL answer about another repository than the pinned one by its status, and throws the binding's refusal of it", async () => {
    const sent = answering(json({ data: { repository: { databaseId: 43 } } }));
    expect(thrownAs(await rejection(checks(pinned())))).toEqual(
      [GitHubApiError, "GitHub moved octo/repo out of the bound repository; it was not followed.", 404]);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["graphql.checks.list", "success", "", "", 200]]);
  });

  it("counts a GraphQL answer whose repository is null beside the error that says why as any answer with data and errors", async () => {
    const sent = answering(
      json({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository", type: "NOT_FOUND" }] }));
    expect(thrownAs(await rejection(checks(api())))).toEqual([GitHubApiError, "Repository octo/repo was not found.", 404]);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["graphql.checks.list", "error", "api", "partial", 200]]);
  });

  it("counts a GraphQL answer that lists what is no error beside its data as one with data and errors", async () => {
    answering(json({ data: { node: null }, errors: [null] }));
    expect(await query()).toEqual({ data: { node: null }, errors: [null] });
    expect(calls()).toEqual([["graphql.deployment.get", "error", "api", "partial", 200]]);
  });

  it("reads every page of a list of webhooks, each counted", async () => {
    const full = Array.from({ length: 100 }, (_, id) => ({ id }));
    const sent = answering(json(full), json([{ id: 100 }]));
    expect(await api().listRepoWebhooks(42)).toEqual([...full, { id: 100 }]);
    expect(sent.map(({ url }) => url)).toEqual([1, 2].map(number => `${API}/repositories/42/hooks?per_page=100&page=${number}`));
    // The two requests of the one listing are summed into one point.
    expect(calls()).toEqual([["hooks.list", "success", "", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([2]);
  });

  it("reads the deliveries of the next page a list names, and stops at the first that is older than is asked for", async () => {
    const next = `<${API}/repositories/42/hooks/100/deliveries?per_page=100&cursor=c2>; rel="next"`;
    const sent = answering(
      json([{ id: 3, delivered_at: "2026-01-03T00:00:00Z" }], { headers: { Link: next } }),
      json([{ id: 2, delivered_at: "2026-01-02T00:00:00Z" }, { id: 1, delivered_at: "2025-12-31T00:00:00Z" }], { headers: { Link: next } }),
    );
    expect(await api().listRepoWebhookDeliveries(42, 100, Date.parse("2026-01-01T00:00:00Z")))
      .toEqual([{ id: 3, delivered_at: "2026-01-03T00:00:00Z" }, { id: 2, delivered_at: "2026-01-02T00:00:00Z" }]);
    expect(sent.map(({ url }) => url)).toEqual([
      `${API}/repositories/42/hooks/100/deliveries?per_page=100`,
      `${API}/repositories/42/hooks/100/deliveries?per_page=100&cursor=c2`,
    ]);
    expect(calls()).toEqual([["deliveries.list", "success", "", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([2]);
  });
});

describe("how the download of a job's log is counted, by the reading of it", () => {
  const location = "https://storage.example/logs/21?sig=secret";
  const encoder = new TextEncoder();
  // A job's log as GitHub stores it, and what the gatekeeper reads of it.
  const RAW = [
    "2026-01-01T00:00:00.0000000Z ##[group]Run npm test",
    "2026-01-01T00:00:01.0000000Z ok 1 parses",
    "2026-01-01T00:00:02.0000000Z ##[endgroup]",
    "2026-01-01T00:00:03.0000000Z ##[error]not ok 2 renders",
    "",
  ].join("\n");
  const READ = { lines: ["▶ Run npm test", "ok 1 parses", "error: not ok 2 renders"], firstLine: 1, totalLines: 3 };

  const download = () => api().downloadJobLog(location, reading);

  // An answer whose log arrives up to the end of its first line, and then fails as `fail` says.
  const cutOff = (fail: (controller: ReadableStreamDefaultController<Uint8Array>) => void) => () =>
    new Response(new ReadableStream<Uint8Array>({
      start: controller => controller.enqueue(encoder.encode(RAW.slice(0, RAW.indexOf("\n") + 1))),
      pull: fail,
    }));

  it("counts a log that arrived whole as a success, and returns what its reader read of it", async () => {
    const sent = answering(() => new Response(RAW));
    expect(await download()).toEqual(READ);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["logs.download", "success", "", "", 200]]);
  });

  it("counts a log whose transfer is cut off after some of it arrived as no success, sends for it once, and throws what cut it off", async () => {
    const cut = new Error("connection reset");
    const sent = answering(cutOff(controller => controller.error(cut)));
    expect(await rejection(download())).toBe(cut);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["logs.download", "error", "parse", "", 200]]);
  });

  describe("a log longer than its reader keeps", () => {
    const CHUNKS = 120;
    const LINES = 500;

    // A log of `CHUNKS` chunks of `LINES` lines, each chunk handed over only once it is asked for,
    // with a reader of it. It counts the bytes it handed over and, of the lines it handed over,
    // the most that its reader had not taken in when the next chunk was asked for.
    function counted() {
      const count = { bytes: 0, ahead: 0 };
      let chunk = 0;
      let taken = 0;
      const log = new ReadableStream<Uint8Array>({
        pull: controller => {
          count.ahead = Math.max(count.ahead, chunk * LINES - taken);
          if (chunk === CHUNKS) return controller.close();
          const first = chunk++ * LINES;
          const bytes = encoder.encode(Array.from({ length: LINES }, (_, line) => numbered(first + line)).join(""));
          count.bytes += bytes.byteLength;
          controller.enqueue(bytes);
        },
      }, { highWaterMark: 0 });
      const read = (body: ReadableStream<Uint8Array>) => readCiLog(body, line => {
        taken++;
        return normalizeGitHubLogLine(line);
      });
      return { log, count, read };
    }

    it("returns the tail its reader keeps, counted a success, and holds no more of the log than the reader alone does", async () => {
      const alone = counted();
      const kept = await alone.read(alone.log);

      const served = counted();
      const sent = answering(() => new Response(served.log));
      const log = await api().downloadJobLog(location, served.read);

      expect(log).toEqual(kept);
      // Every line is counted, and only the last of them are kept: at most the reader's 8 MiB, at
      // two bytes a character.
      expect(log.totalLines).toBe(CHUNKS * LINES);
      expect(log.firstLine).toBeGreaterThan(1);
      expect(log.lines.at(-1)).toBe(keptOf(CHUNKS * LINES - 1));
      expect(log.lines.reduce((bytes, line) => bytes + 2 * line.length, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
      // Each byte is asked for once, and no chunk before the reader has taken in the one before it.
      expect(served.count).toEqual({ bytes: CHUNKS * LINES * numbered(0).length, ahead: 0 });
      expect(served.count).toEqual(alone.count);
      expect(sent).toHaveLength(1);
      expect(calls()).toEqual([["logs.download", "success", "", "", 200]]);
    });
  });

  it("counts a log its reader refuses for its size as no success, and asks for no more of it", async () => {
    const chunk = new Uint8Array(1024);
    let pulled = 0;
    let cancelled = false;
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      pull: controller => {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel: () => { cancelled = true; },
    }, { highWaterMark: 0 })));
    const error = await rejection(api().downloadJobLog(
      location, log => readCiLog(log, normalizeGitHubLogLine, { maxBytes: 4 * chunk.byteLength })));
    expect(error).toBeInstanceOf(CiLogTooLargeError);
    expect(error).toMatchObject({ maxBytes: 4 * chunk.byteLength });
    // The read ends with the chunk that passes the limit.
    expect(pulled).toBe(5 * chunk.byteLength);
    expect(cancelled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["logs.download", "error", "parse", "", 200]]);
  });

  describe("a log whose reading the two minutes of its request cut off", () => {
    // The timeout of each attempt, in the order the attempts were made.
    let timeouts: AbortController[];

    beforeEach(() => {
      timeouts = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
        const timeout = new AbortController();
        timeouts.push(timeout);
        return timeout.signal;
      });
    });

    // An answer whose log stops after its first line until the timeout of its attempt fires.
    const stalled = cutOff(controller => {
      const timeout = timeouts.at(-1);
      timeout?.abort(new DOMException("The operation timed out.", "TimeoutError"));
      controller.error(timeout?.signal.reason);
    });

    // A request that no answer comes to before the timeout of its attempt fires, which fails the attempt.
    const unanswered = (): Response => {
      const timeout = timeouts.at(-1);
      timeout?.abort(new DOMException("The operation timed out.", "TimeoutError"));
      throw timeout?.signal.reason;
    };

    it("is counted a timeout, is not asked for again, and throws the timeout", async () => {
      const sent = answering(stalled, () => new Response(RAW));
      const thrown = await rejection(download());
      expect(thrown).toMatchObject({ name: "TimeoutError" });
      expect(thrown).toBe(timeouts[0].signal.reason);
      expect(sent.map(({ method, url }) => [method, url])).toEqual([["GET", location]]);
      expect(vi.mocked(AbortSignal.timeout).mock.calls).toEqual([[120_000]]);
      expect(calls()).toEqual([["logs.download", "error", "timeout", "", 200]]);
    });

    // GitHub signs the location for a minute: a later send may be refused for its signature.
    it("is sent once where its storage is busy", async () => {
      const sent = answering(() => new Response("busy", { status: 503 }), () => new Response(RAW));
      expect(await rejection(download())).toMatchObject({ name: "GitHubApiError", status: 503 });
      expect(sent).toHaveLength(1);
      expect(vi.mocked(AbortSignal.timeout).mock.calls).toEqual([[120_000]]);
      expect(calls()).toEqual([["logs.download", "error", "http", "", 503]]);
    });

    it("leaves the download that is asked for next its own request and its own two minutes", async () => {
      const sent = answering(stalled, () => new Response(RAW));
      expect(await rejection(download())).toMatchObject({ name: "TimeoutError" });
      expect(await download()).toEqual(READ);
      expect(sent).toHaveLength(2);
      expect(vi.mocked(AbortSignal.timeout).mock.calls).toEqual([[120_000], [120_000]]);
      expect(calls()).toEqual([["logs.download", "error", "timeout", "", 200], ["logs.download", "success", "", "", 200]]);
    });

    // An answer whose log stops after its first line and, once the timeout of its attempt has
    // fired, goes on as `next` says.
    const late = (next: (controller: ReadableStreamDefaultController<Uint8Array>) => void) => cutOff(controller => {
      timeouts.at(-1)?.abort(new DOMException("The operation timed out.", "TimeoutError"));
      next(controller);
    });

    it.each<[string, Error]>([
      ["a lost connection", new Error("connection reset")],
      ["an abort", new DOMException("The operation was aborted.", "AbortError")],
    ])("is not asked for again where its reading fails with %s once those two minutes have run out, and throws that", async (_name, failure) => {
      const sent = answering(late(controller => controller.error(failure)), () => new Response(RAW));
      expect(await rejection(download())).toBe(failure);
      expect(sent.map(({ method, url }) => [method, url])).toEqual([["GET", location]]);
      expect(vi.mocked(AbortSignal.timeout).mock.calls).toEqual([[120_000]]);
      // The reading did not fail as a timeout fails one, and is not counted as one.
      expect(calls()).toEqual([["logs.download", "error", "parse", "", 200]]);
    });

    it("is not asked for again where its reader refuses it for its size once those two minutes have run out, and throws the refusal", async () => {
      // The chunk that arrives as the timeout fires is the one that passes the reader's limit.
      const sent = answering(late(controller => controller.enqueue(new Uint8Array(4096))), () => new Response(RAW));
      const error = await rejection(api().downloadJobLog(
        location, log => readCiLog(log, normalizeGitHubLogLine, { maxBytes: 4096 })));
      expect(error).toBeInstanceOf(CiLogTooLargeError);
      expect(error).toMatchObject({ maxBytes: 4096 });
      expect(sent.map(({ method, url }) => [method, url])).toEqual([["GET", location]]);
      expect(calls()).toEqual([["logs.download", "error", "parse", "", 200]]);
    });

    it("is sent once where no answer comes in its two minutes", async () => {
      const sent = answering(unanswered, () => new Response(RAW));
      expect(await rejection(download())).toMatchObject({ name: "TimeoutError" });
      expect(sent).toHaveLength(1);
      expect(calls().map(([, outcome, reason]) => [outcome, reason])).toEqual([["error", "timeout"]]);
    });
  });
});

describe("a read whose answer the timeout of its attempt cut off", () => {
  // The timeout of each attempt, in the order the attempts were made.
  let timeouts: AbortController[];

  beforeEach(() => {
    timeouts = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const timeout = new AbortController();
      timeouts.push(timeout);
      return timeout.signal;
    });
  });

  // A 200 with `headers` whose JSON stops after its start until the timeout of its attempt fires.
  const stalled = (headers: Record<string, string>) => () => new Response(new ReadableStream<Uint8Array>({
    start: controller => controller.enqueue(new TextEncoder().encode('{"number":')),
    pull(controller) {
      const timeout = timeouts.at(-1);
      timeout?.abort(new DOMException("The operation timed out.", "TimeoutError"));
      controller.error(timeout?.signal.reason);
    },
  }), { headers: { "content-type": "application/json", ...headers } });

  it("is asked for again where the answer names no wait", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sent = answering(stalled({ "x-ratelimit-remaining": "41" }), () => Response.json({ number: 5 }));
    expect(await api().getIssue("octo", "repo", 5)).toMatchObject({ number: 5 });
    expect(sent).toHaveLength(2);
    expect(calls()).toEqual([["issues.get", "error", "timeout", "", 200], ["issues.get", "success", "", "", 200]]);
  });

  // GitHub names its wait on a success too, and refuses a request sent before it is over: the
  // refusal would be thrown in place of the timeout.
  it.each<[string, Record<string, string>]>([
    ["a rate limit with nothing left of it", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" }],
    ["a rate limit with nothing left that is about to reset", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }],
    ["a retry-after", { "retry-after": "5" }],
  ])("is not asked for again where the answer names %s, and throws the timeout", async (_name, headers) => {
    const sent = answering(stalled(headers), () => new Response("rate limited", { status: 403 }));
    const thrown = await rejection(api().getIssue("octo", "repo", 5));
    expect(thrown).toBe(timeouts[0].signal.reason);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["issues.get", "error", "timeout", "", 200]]);
  });
});

// A git fetch, as the transport sends one.
const fetched = () => api().fetchGitUploadPack("octo", "repo", new Uint8Array([48, 48, 48, 48]));

// A body that records whether it was read and whether it was cancelled.
function watched(chunk: string) {
  const seen = { read: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull: controller => {
      seen.read = true;
      controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
    cancel: () => { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { seen, body };
}

describe("how a git fetch is counted, by whether its answer holds a pack", () => {
  it.each<[string, Record<string, string>, string]>([
    ["an HTML page", { "content-type": "text/html; charset=utf-8; secret=parameter" }, "another content type"],
    ["the report of a push", PUSH_RESULT, "another content type"],
    ["a body of no content type", {}, "no content type"],
  ])("counts a fetch answered 200 by %s as the error it is thrown as, and reads none of it", async (_name, headers, named) => {
    const { seen, body } = watched("<html>Bad gateway</html>");
    const sent = answering(() => new Response(body, { headers }));
    expect(thrownAs(await rejection(fetched()))).toEqual([
      GitHubApiError,
      `git fetch failed: expected application/x-git-upload-pack-result but GitHub answered ${named}; ` +
      "this usually means an error page or a proxy answered instead of the git endpoint.",
      502,
    ]);
    expect(seen).toEqual({ read: false, cancelled: true });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.upload-pack", "error", "parse", "", 200]]);
  });

  it.each<[string, Record<string, string>, string]>([
    ["that says it is a pack", PACK_RESULT, "git fetch failed: response had no body"],
    ["of no content type", {},
      "git fetch failed: expected application/x-git-upload-pack-result but GitHub answered no content type; " +
      "this usually means an error page or a proxy answered instead of the git endpoint."],
  ])("counts a fetch answered 200 with no body %s as the error it is thrown as", async (_name, headers, message) => {
    const sent = answering(() => new Response(null, { headers }));
    expect(thrownAs(await rejection(fetched()))).toEqual([GitHubApiError, message, 502]);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.upload-pack", "error", "parse", "", 200]]);
  });

  it.each([
    ["the content type of a pack", "application/x-git-upload-pack-result"],
    ["that content type with a parameter", "application/x-git-upload-pack-result; charset=binary"],
    ["that content type in another case", "Application/X-Git-Upload-Pack-Result"],
  ])("hands on a fetch answered 200 with %s as it came, unread, and counts it a success", async (_name, contentType) => {
    const { seen, body } = watched("0000");
    const answer = new Response(body, { headers: { "content-type": contentType } });
    const sent = answering(() => answer);
    const answered = await fetched();
    // The answer itself, and no copy of it: its pack is the transport's to stream.
    expect(answered).toBe(answer);
    expect([answered.bodyUsed, answered.body?.locked, seen]).toEqual([false, false, { read: false, cancelled: false }]);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.upload-pack", "success", "", "", 200]]);
    expect(await answered.text()).toBe("0000");
  });

  it.each<[number, string, string, string]>([
    [404, "Not Found", "error", "http"],
    [429, "Too Many Requests", "refused", "rate"],
    [503, "Service Unavailable", "error", "http"],
  ])("counts a fetch answered %i by that status, whatever its content type, and throws it with the answer's text", async (status, statusText, outcome, reason) => {
    const sent = answering(() => new Response(" Repository not found.\n", { status, statusText }));
    expect(thrownAs(await rejection(fetched())))
      .toEqual([GitHubApiError, `git fetch failed: ${status} ${statusText}: Repository not found.`, status]);
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.upload-pack", outcome, reason, "", status]]);
  });
});

describe("how a push is counted, by the report git answers it with", () => {
  const OLD = "1".repeat(40);
  const NEW = "2".repeat(40);
  const UPDATE = { branch: "main", oldSha: OLD, newSha: NEW };

  // Pushes an update of `main` through the kit's transport, as the gatekeeper does.
  const push = () => pushGitRefUpdate(
    body => api().fetchGitReceivePack("octo", "repo", "main", body), UPDATE, pack());

  // The answers GitHub gives a push with a 200, each with the outcome and the reason the request
  // is counted with.
  const REPORTS: [name: string, counted: "success" | "error api" | "error parse", answer: () => Response][] = [
    ["applied the update", "success", landed],
    ["refused an update that is no fast-forward", "error api", report("unpack ok", "ng refs/heads/main fetch first")],
    ["refused an update of a protected branch", "error api",
      report("unpack ok", "ng refs/heads/main protected branch hook declined")],
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
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", outcome, reason, "", 200]]);
  });

  it.each(REPORTS)("ends a push whose answer %s as the transport ends one handed that answer", async (_name, _counted, answer) => {
    answering(answer);
    const ended = await ending(push());
    expect(ended).toEqual(await ending(pushGitRefUpdate(async () => answer(), UPDATE, pack())));
    // Only an applied update ends a push with nothing.
    expect(ended === undefined).toBe(answer === landed);
  });

  it("throws the refusal of an update as the transport's rejection, with git's reason", async () => {
    answering(report("unpack ok", "ng refs/heads/main protected branch hook declined"));
    const error = await rejection(push());
    expect(error).toBeInstanceOf(GitRefUpdateRejectedError);
    expect(error).toMatchObject({
      message: "git push rejected for refs/heads/main: protected branch hook declined",
      reason: "protected branch hook declined",
    });
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

  it.each<[string, Record<string, string>, string]>([
    ["an HTML page", { "content-type": "text/html; charset=utf-8; secret=parameter" }, "another content type"],
    ["the pack of a fetch", PACK_RESULT, "another content type"],
    ["a body of no content type", {}, "no content type"],
  ])("reads no report from a push answered 200 by %s, however long it is, and counts it as the error it is thrown as", async (_name, headers, named) => {
    const page = new Uint8Array(MAX_RECEIVE_PACK_RESPONSE_BYTES + 1).fill(0x20);
    const seen = { read: false, cancelled: false };
    const sent = answering(() => new Response(new ReadableStream<Uint8Array>({
      pull: controller => {
        seen.read = true;
        controller.enqueue(page);
        controller.close();
      },
      cancel: () => { seen.cancelled = true; },
    }, { highWaterMark: 0 }), { headers }));
    expect(thrownAs(await rejection(push()))).toEqual([
      GitHubApiError,
      `git push failed: expected application/x-git-receive-pack-result but GitHub answered ${named}; ` +
      "this usually means an error page or a proxy answered instead of the git endpoint.",
      502,
    ]);
    expect(seen).toEqual({ read: false, cancelled: true });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", "error", "parse", "", 200]]);
  });

  it("counts a push answered 200 with no body and no content type as the error it is thrown as", async () => {
    const sent = answering(() => new Response(null));
    expect(await rejection(push())).toMatchObject({
      name: "GitHubApiError", status: 502,
      message: expect.stringContaining("git push failed: expected application/x-git-receive-pack-result but GitHub answered no content type"),
    });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", "error", "parse", "", 200]]);
  });

  it.each<[number, string, string, string]>([
    [404, "Not Found", "error", "http"],
    [429, "Too Many Requests", "refused", "rate"],
    [503, "Service Unavailable", "error", "http"],
  ])("counts a push answered %i by that status, and throws it with the answer's text", async (status, statusText, outcome, reason) => {
    const sent = answering(() => new Response(" Repository not found.\n", { status, statusText }));
    const error = await rejection(push());
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status, message: `git push failed: ${status} ${statusText}: Repository not found.` });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["git.receive-pack", outcome, reason, "", status]]);
  });

  it.each([200, 202])("answers a push GitHub answered %i with that status over the report it read, and counts it with it", async status => {
    const lines = new Blob([encodePktLine("unpack ok"), encodePktLine("ok refs/heads/main"), FLUSH_PKT]);
    answering(() => new Response(lines, { status, headers: PUSH_RESULT }));
    const answered = await api().fetchGitReceivePack("octo", "repo", "main", pack());
    expect(answered.status).toBe(status);
    expect(new Uint8Array(await answered.arrayBuffer())).toEqual(new Uint8Array(await lines.arrayBuffer()));
    expect(calls()).toEqual([["git.receive-pack", "success", "", "", status]]);
  });

  it("streams the command and the pack to GitHub as the transport composed them", async () => {
    const sent = answering(landed);
    await push();
    const [{ method, url, init }] = sent;
    expect([method, url, init.redirect]).toEqual(["POST", "https://github.com/octo/repo.git/git-receive-pack", "manual"]);
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: "application/x-git-receive-pack-result",
      authorization: `Basic ${btoa("x-access-token:test-token")}`,
      "content-type": "application/x-git-receive-pack-request",
      "user-agent": "Cloudflare-Gadgets",
    });
    // The body is the transport's stream itself, read by `fetch` alone.
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(init.body).text())
      .toBe(`${new TextDecoder().decode(encodePktLine(`${OLD} ${NEW} refs/heads/main\0report-status agent=cloudflare-gadgets`))}0000PACK`);
  });
});

describe("which requests are sent again", () => {
  it.each([502, 503, 504])("sends a read answered %i three times, counting each", async status => {
    const sent = answering(json({ message: "unavailable" }, { status }));
    expect(await rejection(api().getIssue("octo", "repo", 5))).toMatchObject({ name: "GitHubApiError", status });
    expect(sent).toHaveLength(3);
    expect(calls()).toEqual(Array.from({ length: 3 }, () => ["issues.get", "error", "http", "", status]));
  });

  it("answers a read whose second attempt succeeds", async () => {
    const sent = answering(json({ message: "Bad Gateway" }, { status: 502 }), json({ number: 5 }));
    expect(await api().getIssue("octo", "repo", 5)).toEqual({ number: 5 });
    expect(sent).toHaveLength(2);
    expect(calls()).toEqual([["issues.get", "error", "http", "", 502], ["issues.get", "success", "", "", 200]]);
  });

  it("sends a read that fails for a reason of its own once", async () => {
    const sent = answering(json({ message: "Server Error" }, { status: 500 }));
    expect(await rejection(api().getIssue("octo", "repo", 5))).toMatchObject({ status: 500 });
    expect(sent).toHaveLength(1);
  });

  it.each<[string, (github: GitHubApi) => Promise<unknown>]>([
    ["a REST write", github => github.createIssueComment("octo", "repo", 5, "Hello")],
    ["a merge", github => github.mergePullRequest("octo", "repo", 7, {})],
    ["a GraphQL query", query],
    ["a token's revocation", () => revokeOAuthToken("gho_token", "client-id", "client-secret")],
    ["a git fetch", github => github.fetchGitUploadPack("octo", "repo", new Uint8Array([48, 48, 48, 48]))],
    ["a git push", github => github.fetchGitReceivePack("octo", "repo", "main", pack())],
  ])("sends %s once, whatever it is answered", async (_name, send) => {
    const sent = answering(json({ message: "Service Unavailable" }, { status: 503 }));
    expect(await rejection(send(api()))).toMatchObject({ name: "GitHubApiError", status: 503 });
    expect(sent).toHaveLength(1);
  });

  describe("a request whose answer names when GitHub takes it again", () => {
    // The fixed time of the fake clock, a whole second, as the reset of a rate limit is.
    const NOW = Date.parse("2026-01-01T00:00:00Z");
    // The headers of a spent primary rate limit that resets `seconds` from the clock's time.
    const spentUntil = (seconds: number) =>
      ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + seconds) });
    const limited = ["issues.get", "refused", "rate", "", 429];
    const served = ["issues.get", "success", "", "", 200];
    // The milliseconds of the fake clock at which each answer was asked for.
    let sentAt: number[];

    beforeEach(() => {
      vi.useFakeTimers({ now: NOW });
      sentAt = [];
      // A share of the client's backoff that is none of the waits an answer names here.
      vi.mocked(Math.random).mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // An answer that notes when it was asked for.
    const timed = (answer: () => Response) => () => {
      sentAt.push(Date.now() - NOW);
      return answer();
    };
    const refusing = (status: number, headers: Record<string, string>, message = "API rate limit exceeded") =>
      timed(json({ message }, { status, headers }));

    it.each<[name: string, status: number, headers: Record<string, string>, waitMs: number]>([
      ["a 429 whose spent limit resets in 4 seconds", 429, spentUntil(4), 4000],
      ["a 429 with a retry-after of 3", 429, { "retry-after": "3" }, 3000],
      ["a 429 with a retry-after of 3 and a spent limit that resets in 7 seconds", 429, { "retry-after": "3", ...spentUntil(7) }, 7000],
      ["a 429 with a retry-after of 8 and a spent limit that resets in 2 seconds", 429, { "retry-after": "8", ...spentUntil(2) }, 8000],
      ["a 429 with a retry-after of 10, the longest wait", 429, { "retry-after": "10" }, 10_000],
      ["a 429 whose spent limit has reset", 429, spentUntil(-30), 0],
      ["a 429 with a retry-after of 0", 429, { "retry-after": "0" }, 0],
      ["a 429 with a retry-after of 3 and a limit that is not spent", 429,
        { "retry-after": "3", "x-ratelimit-remaining": "12", "x-ratelimit-reset": String(NOW / 1000 + 60) }, 3000],
      ["a 503 with a retry-after of 4", 503, { "retry-after": "4" }, 4000],
      ["a 502 whose spent limit resets in 2 seconds", 502, spentUntil(2), 2000],
    ])("sends a read answered %s again after exactly that wait", async (_name, status, headers, waitMs) => {
      const sent = answering(refusing(status, headers), timed(json({ number: 5 })));
      const read = api().getIssue("octo", "repo", 5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await read).toEqual({ number: 5 });
      expect(sent.map(({ method, url }) => [method, url]))
        .toEqual(Array.from({ length: 2 }, () => ["GET", `${API}/repos/octo/repo/issues/5`]));
      expect(sentAt).toEqual([0, waitMs]);
      expect(calls()).toEqual([
        ["issues.get", status === 429 ? "refused" : "error", status === 429 ? "rate" : "http", "", status], served,
      ]);
    });

    it("sends no read before the reset its 429 names", async () => {
      answering(refusing(429, spentUntil(4)), timed(json({ number: 5 })));
      const read = api().getIssue("octo", "repo", 5);
      await vi.advanceTimersByTimeAsync(3999);
      expect(sentAt).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await read).toEqual({ number: 5 });
      expect(sentAt).toEqual([0, 4000]);
    });

    it.each<[name: string, status: number, headers: Record<string, string>, point: (string | number)[]]>([
      ["a 429 whose spent limit resets in a minute", 429, spentUntil(60), limited],
      ["a 429 whose spent limit resets in 11 seconds", 429, spentUntil(11), limited],
      ["a 429 with a retry-after of 60", 429, { "retry-after": "60" }, limited],
      ["a 429 with a retry-after of 11", 429, { "retry-after": "11" }, limited],
      ["a 429 with a retry-after of 3 and a spent limit that resets in a minute", 429, { "retry-after": "3", ...spentUntil(60) }, limited],
      ["a 429 with a retry-after of 60 and a spent limit that resets in 3 seconds", 429, { "retry-after": "60", ...spentUntil(3) }, limited],
      ["a 429 that names no wait", 429, {}, limited],
      ["a 429 with the reset of a limit that is not spent", 429,
        { "x-ratelimit-remaining": "12", "x-ratelimit-reset": String(NOW / 1000 + 4) }, limited],
      ["a 429 with a retry-after that is no count of seconds", 429, { "retry-after": "soon" }, limited],
      ["a 429 with a retry-after that is a fraction", 429, { "retry-after": "1.5" }, limited],
      ["a 429 with a retry-after that is a date", 429, { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }, limited],
      ["a 429 with a retry-after that cannot be read and a spent limit that resets in 3 seconds", 429,
        { "retry-after": "soon", ...spentUntil(3) }, limited],
      ["a 429 whose spent limit names no reset", 429, { "x-ratelimit-remaining": "0" }, limited],
      ["a 429 whose spent limit names a reset that cannot be read", 429,
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" }, limited],
      ["a 429 with a retry-after of 3 and a spent limit whose reset cannot be read", 429,
        { "retry-after": "3", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" }, limited],
      ["a 503 with a retry-after of 60", 503, { "retry-after": "60" }, ["issues.get", "error", "http", "", 503]],
      ["a 503 with a retry-after that cannot be read", 503, { "retry-after": "soon" }, ["issues.get", "error", "http", "", 503]],
      ["a 503 with a retry-after that is a date", 503, { "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }, ["issues.get", "error", "http", "", 503]],
      ["a 502 with a retry-after that is a fraction", 502, { "retry-after": "1.5" }, ["issues.get", "error", "http", "", 502]],
      ["a 504 with an empty retry-after", 504, { "retry-after": "" }, ["issues.get", "error", "http", "", 504]],
      ["a 503 whose spent limit names no reset", 503, { "x-ratelimit-remaining": "0" }, ["issues.get", "error", "http", "", 503]],
      ["a 504 whose spent limit resets in a minute", 504, spentUntil(60), ["issues.get", "error", "http", "", 504]],
      ["a 403 whose spent limit resets in 4 seconds", 403, spentUntil(4), ["issues.get", "refused", "rate", "", 403]],
      ["a 403 with a retry-after of 1", 403, { "retry-after": "1" }, ["issues.get", "refused", "rate", "", 403]],
      ["a 500 with a retry-after of 1", 500, { "retry-after": "1" }, ["issues.get", "error", "http", "", 500]],
    ])("sends a read answered %s once, waits for nothing, and throws that answer", async (_name, status, headers, point) => {
      const sent = answering(refusing(status, headers));
      const error = await rejection(api().getIssue("octo", "repo", 5));
      expect(error).toBeInstanceOf(GitHubApiError);
      // The message is the answer's own, read from the body the one send was answered with.
      expect(error).toMatchObject({ status, message: "API rate limit exceeded", rateLimited: status === 429 || status === 403 });
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(calls()).toEqual([point]);
    });

    it("sends a read that stays rate limited three times at most, each after the wait the answer before it names", async () => {
      const sent = answering(refusing(429, { "retry-after": "2" }));
      const failed = rejection(api().getIssue("octo", "repo", 5));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await failed).toMatchObject({ name: "GitHubApiError", status: 429, rateLimited: true });
      expect(sent).toHaveLength(3);
      expect(sentAt).toEqual([0, 2000, 4000]);
      expect(calls()).toEqual([limited, limited, limited]);
    });

    it.each([429, 503])("sends a read whose answers keep naming one reset three times at most: after the wait to it, then at once", async status => {
      const sent = answering(refusing(status, spentUntil(2)));
      const failed = rejection(api().getIssue("octo", "repo", 5));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await failed).toMatchObject({ name: "GitHubApiError", status });
      expect(sent).toHaveLength(3);
      // The third send finds the reset past, and waits for nothing.
      expect(sentAt).toEqual([0, 2000, 2000]);
      expect(calls()).toEqual(Array.from({ length: 3 }, () =>
        status === 429 ? limited : ["issues.get", "error", "http", "", status]));
    });

    it.each([502, 503, 504])("sends a read answered %i with no wait named three times, after the client's backoff", async status => {
      const sent = answering(refusing(status, {}, "unavailable"));
      const failed = rejection(api().getIssue("octo", "repo", 5));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await failed).toMatchObject({ name: "GitHubApiError", status, message: "unavailable" });
      expect(sent).toHaveLength(3);
      // Half of 500 ms, then half of 1 000 ms: the random share of the backoff's doubling ceiling.
      expect(sentAt).toEqual([0, 250, 750]);
      expect(calls()).toEqual(Array.from({ length: 3 }, () => ["issues.get", "error", "http", "", status]));
    });

    it.each<[string, Record<string, string>, (github: GitHubApi) => Promise<unknown>, string]>([
      ["a REST write with a retry-after of 1", { "retry-after": "1" },
        github => github.createIssueComment("octo", "repo", 5, "Hello"), "comments.create"],
      ["a REST write whose spent limit has reset", spentUntil(-30),
        github => github.createIssueComment("octo", "repo", 5, "Hello"), "comments.create"],
      ["a GraphQL query with a retry-after of 1", { "retry-after": "1" }, query, "graphql.deployment.get"],
      ["a git fetch with a retry-after of 1", { "retry-after": "1" },
        github => github.fetchGitUploadPack("octo", "repo", new Uint8Array([48, 48, 48, 48])), "git.upload-pack"],
      ["a git push with a retry-after of 1", { "retry-after": "1" },
        github => github.fetchGitReceivePack("octo", "repo", "main", pack()), "git.receive-pack"],
    ])("sends %s once when it is answered 429", async (_name, headers, send, name) => {
      const sent = answering(refusing(429, headers));
      expect(await rejection(send(api()))).toMatchObject({ name: "GitHubApiError", status: 429, rateLimited: true });
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(calls()).toEqual([[name, "refused", "rate", "", 429]]);
    });

    it("sends the download of a log once, whatever wait its answer names: its location is signed for a minute", async () => {
      const location = "https://storage.example/logs/21?sig=secret";
      const sent = answering(refusing(429, { "retry-after": "2" }), timed(() => new Response("log")));
      const download = rejection(api().downloadJobLog(location, text));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await download).toMatchObject({ name: "GitHubApiError", status: 429 });
      expect(sent).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(calls()).toEqual([["logs.download", "refused", "rate", "", 429]]);
    });
  });

  it.each([
    ["a date", "Thu, 01 Jan 2026 00:00:03 GMT"],
    ["a word", "soon"],
  ])("sends the download of a log once where its storage answers 503 with a retry-after that is %s", async (_name, retryAfter) => {
    const sent = answering(() => new Response("busy", { status: 503, headers: { "retry-after": retryAfter } }));
    expect(await rejection(api().downloadJobLog("https://storage.example/logs/21?sig=secret", text)))
      .toMatchObject({ name: "GitHubApiError", status: 503 });
    expect(sent).toHaveLength(1);
    expect(calls()).toEqual([["logs.download", "error", "http", "", 503]]);
  });

  it("gives a git transfer and a log's download two minutes, and any other request the default", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    answering(packed, landed, () => new Response("0000"));
    const github = api();

    await github.fetchGitUploadPack("octo", "repo", new Uint8Array([48, 48, 48, 48]));
    await github.fetchGitReceivePack("octo", "repo", "main", pack());
    await github.downloadJobLog("https://storage.example/logs/21?sig=secret", log => log.cancel());
    await github.getIssue("octo", "repo", 5);

    expect(timeouts.mock.calls).toEqual([[120_000], [120_000], [120_000], [30_000]]);
  });
});

describe("GitHubApiError", () => {
  it("is what a failed request rejects with, carrying GitHub's message", async () => {
    answering(json({ message: "Validation Failed" }, { status: 422 }));
    const error = await rejection(api().createIssue("octo", "repo", { title: "" }));
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 422, message: "Validation Failed", details: { message: "Validation Failed" } });
  });
});
