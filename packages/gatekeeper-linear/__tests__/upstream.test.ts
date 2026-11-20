// The requests this gatekeeper sends to Linear, the name each is counted under, and how an
// answer is counted where its status does not say. Linear's requests share their URLs, so every
// name is a literal at its call site: these drive the real client against a stubbed fetch and
// read the points it writes.
import { env as bindings } from "cloudflare:workers";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserAccount } from "../src/linear";
import {
  GRAPHQL_OPERATIONS, LinearApi, LinearApiError, exchangeAuthCode, refreshAccessToken, revokeToken,
  linearUpstream, type GraphqlOperation,
} from "../src/linear-api";

// The account's Durable Object is driven as a plain class, beside the shared stub's `env`.
vi.mock("cloudflare:workers", async importOriginal => ({
  ...await importOriginal<typeof import("cloudflare:workers")>(),
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: vi.fn(),
  RpcStub: vi.fn(),
  WorkerEntrypoint: vi.fn(),
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/linear-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/linear-workspace-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-team-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-issue-configurator-ui.txt", () => ({ default: "" }));

const GRAPHQL = "https://api.linear.app/graphql";
const TOKEN = "https://api.linear.app/oauth/token";
const REVOKE = "https://api.linear.app/oauth/revoke";

type Point = { blobs?: unknown[]; doubles?: unknown[] };
type Sent = [url: string, init: RequestInit];

const ambient = bindings as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
let points: Point[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void points.push(point) };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A written point's value in one column.
function column(point: Point, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its operation, outcome, reason and HTTP status.
function counted() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// One column of each point written.
function columnOf(slot: string) {
  return points.map(point => column(point, slot));
}

// A global fetch that gives each of `answers` in turn, and the last to every later request. An
// error is thrown.
function answering(...answers: (Response | Error)[]) {
  const fetch = vi.fn(async (..._sent: Sent) => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === undefined) throw new Error("the test listed no answer");
    if (next instanceof Error) throw next;
    return next.clone();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// The method and URL of each request sent.
function sent(fetch: ReturnType<typeof answering>) {
  return fetch.mock.calls.map(([url, init]) => [init.method, url]);
}

// An account's Durable Object, driven as a plain class over storage that holds a grant with
// `tokens`, and what that storage holds.
function accountHolding(tokens: { accessToken: string; refreshToken?: string }) {
  const stored = new Map<string, unknown>([
    ["grant", { ...tokens, expiresAt: Date.now() + 3600_000, scopes: ["read"] }],
  ]);
  const kv = {
    get: (key: string) => structuredClone(stored.get(key)),
    put: (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    delete: (key: string) => stored.delete(key),
    list: ({ prefix }: { prefix: string }) => [...stored].filter(([key]) => key.startsWith(prefix)),
  };
  const storage = { kv, deleteAlarm: async () => {}, deleteAll: async () => stored.clear() };
  const ctx = { storage, id: { toString: () => "account" }, exports: {} };
  return { account: new UserAccount(ctx as never, {} as never), stored };
}

const data = (value: unknown) => Response.json({ data: value });
const linear = () => new LinearApi(async () => "token");
const lastPage = { hasNextPage: false, endCursor: null };
const empty = { nodes: [], pageInfo: lastPage };
const more = (cursor: string) => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: cursor } });
// A project whose teams have a further page.
const project = (id: string) => ({ id, teams: more(`${id}-1`) });

// Each GraphQL request the gatekeeper makes: the names it is counted under, the method that
// sends it, and what Linear answers, request by request.
const GRAPHQL_REQUESTS: [names: GraphqlOperation[], call: (api: LinearApi) => Promise<unknown>, answers: unknown[]][] = [
  [["viewer.get"], api => api.getViewer(), [{ viewer: {}, organization: {} }]],
  [["organization.get"], api => api.getOrganization(), [{ organization: {} }]],
  [["teams.list"], api => api.listTeams({ first: 1 }), [{ teams: empty }]],
  [["teams.find"], api => api.findTeam("ENG"), [{ teams: empty }]],
  [["states.list"], api => api.listWorkflowStates("team"), [{ team: { states: empty } }]],
  [["labels.list"], api => api.listLabels("team"), [{ team: { labels: empty } }]],
  [["members.list"], api => api.listTeamMembers("team"), [{ team: { members: empty } }]],
  [["users.list"], api => api.listUsers({ first: 1 }), [{ users: empty }]],
  [["team-projects.list"], api => api.listProjects({ teamId: "team" }, { first: 1 }), [{ team: { projects: empty } }]],
  [["projects.list", "project-teams.list"], api => api.listProjects({}, { first: 1 }), [
    { projects: { nodes: [{ id: "project", teams: more("c1") }], pageInfo: lastPage } },
    { project: { teams: empty } },
  ]],
  [["cycles.list"], api => api.listCycles("team", { first: 1 }), [{ team: { cycles: empty } }]],
  [["issues.list"], api => api.listIssues({ first: 1 }), [{ issues: empty }]],
  [["issues.search"], api => api.searchIssues({ term: "bug", first: 1 }), [{ searchIssues: empty }]],
  [["issues.get"], api => api.getIssue("ENG-1"), [{ issue: null }]],
  [["comments.list"], api => api.listComments("issue", { first: 1 }), [{ issue: { comments: empty } }]],
  [["projects.get"], api => api.getProject("project"), [{ project: null }]],
  [["issues.create"], api => api.createIssue({ teamId: "team", title: "New" }), [{ issueCreate: { success: true, issue: {} } }]],
  [["issues.update"], api => api.updateIssue("issue", { title: "Renamed" }), [{ issueUpdate: { success: true } }]],
  [["issues.archive"], api => api.setIssueArchived("issue", true), [{ issueArchive: { success: true } }]],
  [["issues.unarchive"], api => api.setIssueArchived("issue", false), [{ issueUnarchive: { success: true } }]],
  [["comments.create"], api => api.createComment("issue", "Done"), [{ commentCreate: { success: true, comment: {} } }]],
  [["comments.delete"], api => api.deleteComment("comment"), [{ commentDelete: { success: true } }]],
  [["labels.create"], api => api.createLabel({ teamId: "team", name: "bug" }), [{ issueLabelCreate: { success: true, issueLabel: {} } }]],
  [["issues.delete"], api => api.deleteIssue("issue"), [{ issueDelete: { success: true } }]],
  [["labels.delete"], api => api.deleteLabel("label"), [{ issueLabelDelete: { success: true } }]],
];

// Each token request: its name, its URL, the function that sends it, and a successful answer.
const grantAnswer = { access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read" };
const client = { clientId: "client", clientSecret: "secret" };
const refresh = () => refreshAccessToken({ ...client, refreshToken: "refresh" });
const TOKEN_REQUESTS: [name: string, url: string, call: () => Promise<unknown>, answer: Response][] = [
  ["token.exchange", TOKEN, () => exchangeAuthCode({ ...client, code: "code", redirectUri: "https://gadgets.example/oauth" }),
    Response.json(grantAnswer)],
  ["token.refresh", TOKEN, refresh, Response.json(grantAnswer)],
  ["token.revoke", REVOKE, () => revokeToken("access"), new Response(null, { status: 200 })],
];

describe("the names of Linear's requests", () => {
  it("counts every request under the source and service of the vendor", () => {
    expect(linearUpstream.vendorId).toBe("linear");
    expect(linearUpstream.source).toBe("gatekeeper.linear.api");
  });

  it("gives no request a name from its URL, which every GraphQL request shares", () => {
    expect(linearUpstream.operationOf("POST", GRAPHQL)).toBe("POST");
    expect(linearUpstream.operationOf("POST", TOKEN)).toBe("POST");
    expect(linearUpstream.operationOf("POST", REVOKE)).toBe("POST");
  });

  it.each(GRAPHQL_REQUESTS)("counts the GraphQL requests %j under those names", async (names, call, answers) => {
    const fetch = answering(...answers.map(data));
    await call(linear());
    expect(sent(fetch)).toEqual(names.map(() => ["POST", GRAPHQL]));
    expect(counted()).toEqual(names.map(name => [name, "success", "", 200]));
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(names.map(() => "linear"));
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(names.map(() => "gatekeeper.linear.api"));
  });

  it("sends a request for every name of the union, and lists none twice", () => {
    const requested = GRAPHQL_REQUESTS.flatMap(([names]) => names);
    expect(requested.toSorted()).toEqual(GRAPHQL_OPERATIONS.toSorted());
    expect(new Set(GRAPHQL_OPERATIONS).size).toBe(GRAPHQL_OPERATIONS.length);
  });

  it.each(TOKEN_REQUESTS)("counts a token request under %s", async (name, url, call, answer) => {
    const fetch = answering(answer);
    await call();
    expect(sent(fetch)).toEqual([["POST", url]]);
    expect(counted()).toEqual([[name, "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["linear"]);
  });
});

describe("how a GraphQL request is sent", () => {
  it("gives every request, a token's included, 30 seconds for each attempt", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answering(data({ organization: {} }), Response.json(grantAnswer), new Response(null, { status: 200 }));
    await linear().getOrganization();
    await refresh();
    await revokeToken("access");
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
  });

  it("follows no redirect, and fails on one", async () => {
    const fetch = answering(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    await expect(linear().getOrganization()).rejects.toMatchObject({ name: "LinearApiError", status: 302 });
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(["manual"]);
    expect(counted()).toEqual([["organization.get", "error", "http", 302]]);
  });

  it.each([
    ["a rate limit", new Response("", { status: 429, headers: { "Retry-After": "0" } }), ["refused", "rate", 429]],
    ["an outage", new Response("", { status: 503, headers: { "Retry-After": "0" } }), ["error", "http", 503]],
  ])("sends a query once when Linear answers %s", async (_name, failure, outcome) => {
    const fetch = answering(failure);
    await expect(linear().getOrganization()).rejects.toBeInstanceOf(LinearApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["organization.get", ...outcome]]);
  });

  it("sends a mutation once when the network fails, and throws what fetch threw", async () => {
    const failure = new TypeError("fetch failed");
    const fetch = answering(failure);
    await expect(linear().createComment("issue", "Done")).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["comments.create", "error", "network", 0]]);
  });
});

describe("how a GraphQL answer is counted", () => {
  it("counts errors inside a 200 as an error of the API, and throws the first", async () => {
    answering(Response.json({ errors: [{ message: "Entity not found", extensions: { code: "INPUT_ERROR" } }] }));
    await expect(linear().getIssue("ENG-1")).rejects.toMatchObject({
      name: "LinearApiError", status: 400, message: "Entity not found", isAuthError: false,
    });
    expect(counted()).toEqual([["issues.get", "error", "api", 200]]);
  });

  it("counts an authentication error inside a 200 as an error of the API, thrown as a 401", async () => {
    answering(Response.json({ errors: [{ message: "Not signed in", extensions: { code: "AUTHENTICATION_ERROR" } }] }));
    await expect(linear().getViewer()).rejects.toMatchObject({ status: 401, isAuthError: true });
    expect(counted()).toEqual([["viewer.get", "error", "api", 200]]);
  });

  it.each([200, 400])("counts a rate-limit error inside a %i as a refusal", async status => {
    answering(Response.json(
      { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, { status }));
    await expect(linear().listIssues({ first: 1 })).rejects.toMatchObject({ status: 400, message: "Rate limit exceeded" });
    expect(counted()).toEqual([["issues.list", "refused", "rate", status]]);
  });

  it("counts errors inside a failed status by the status", async () => {
    answering(Response.json({ errors: [{ message: "Bad query" }] }, { status: 400 }));
    await expect(linear().listIssues({ first: 1 })).rejects.toMatchObject({ status: 400, message: "Bad query" });
    expect(counted()).toEqual([["issues.list", "error", "http", 400]]);
  });

  it.each<[GraphqlOperation, (api: LinearApi) => Promise<unknown>, string, string | undefined]>([
    ["issues.create", api => api.createIssue({ teamId: "team", title: "New" }), "issueCreate", "Linear refused to create the issue."],
    ["issues.update", api => api.updateIssue("issue", { title: "Renamed" }), "issueUpdate", "Linear refused to update the issue."],
    ["issues.archive", api => api.setIssueArchived("issue", true), "issueArchive", "Linear refused to archive the issue."],
    ["issues.unarchive", api => api.setIssueArchived("issue", false), "issueUnarchive", "Linear refused to unarchive the issue."],
    ["comments.create", api => api.createComment("issue", "Done"), "commentCreate", "Linear refused to create the comment."],
    ["labels.create", api => api.createLabel({ teamId: "team", name: "bug" }), "issueLabelCreate", "Linear refused to create the label."],
    // The answer of a deletion is not read: its refusal is counted all the same.
    ["comments.delete", api => api.deleteComment("comment"), "commentDelete", undefined],
    ["issues.delete", api => api.deleteIssue("issue"), "issueDelete", undefined],
    ["labels.delete", api => api.deleteLabel("label"), "issueLabelDelete", undefined],
  ])("counts %s that Linear says it did not apply, inside a 200, as an error of the API", async (name, call, mutation, thrown) => {
    answering(data({ [mutation]: { success: false } }));
    const sending = call(linear());
    if (thrown === undefined) await expect(sending).resolves.toBeUndefined();
    else await expect(sending).rejects.toMatchObject({ name: "LinearApiError", status: 400, message: thrown });
    expect(counted()).toEqual([[name, "error", "api", 200]]);
  });

  it("counts a 200 with no data as an error of the API", async () => {
    answering(Response.json({}));
    await expect(linear().getOrganization()).rejects.toThrow("Linear returned no data.");
    expect(counted()).toEqual([["organization.get", "error", "api", 200]]);
  });

  it("counts a 200 that is no JSON as an answer that could not be parsed", async () => {
    answering(new Response("<html>", { status: 200 }));
    await expect(linear().getOrganization()).rejects.toThrow("Linear returned an unparseable response.");
    expect(counted()).toEqual([["organization.get", "error", "parse", 200]]);
  });

  it("counts a rejected token by its status", async () => {
    answering(new Response("", { status: 401 }));
    await expect(linear().getOrganization()).rejects.toMatchObject({ status: 401, isAuthError: true });
    expect(counted()).toEqual([["organization.get", "error", "http", 401]]);
  });

  it("writes one point per name for a listing that pages through each project's teams", async () => {
    const fetch = vi.fn(async (..._sent: Sent) => {
      const { query, variables } = JSON.parse(_sent[1].body as string) as { query: string; variables: { after?: string } };
      if (query.includes("projects(")) {
        return data({ projects: { nodes: [project("a"), project("b"), project("c")], pageInfo: lastPage } });
      }
      // Two further pages of teams for each project.
      return data({ project: { teams: variables.after?.endsWith("-1") ? more(`${variables.after}-2`) : empty } });
    });
    vi.stubGlobal("fetch", fetch);
    await linear().listProjects({}, { first: 3 });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(counted()).toEqual([["projects.list", "success", "", 200], ["project-teams.list", "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([1, 6]);
  });

  it("writes one point per name for an account's check of several subresources", async () => {
    const fetch = vi.fn(async (..._sent: Sent) => {
      const { query } = JSON.parse(_sent[1].body as string) as { query: string };
      if (query.includes("organization")) return data({ organization: { id: "org", name: "Acme", urlKey: "acme" } });
      return data(query.includes("teams(") ? { teams: empty } : { issue: null });
    });
    vi.stubGlobal("fetch", fetch);
    const { account } = accountHolding({ accessToken: "token" });
    await expect(account.checkSubresourceAccess([
      "workspace/acme", "workspace/acme/team/ENG", "workspace/acme/team/OPS", "workspace/acme/issue/ENG-1",
    ])).resolves.toEqual([true, false, false, false]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(counted().map(([name], at) => [name, columnOf(SUBSERVICE_V1_SLOTS.calls)[at]]).toSorted())
      .toEqual([["issues.get", 1], ["organization.get", 1], ["teams.find", 2]]);
  });
});

// The mutations whose answer the client reads: the name of each, the method that sends it, the
// payload it reads and what it throws where Linear did not apply it.
const READ_MUTATIONS: [GraphqlOperation, (api: LinearApi) => Promise<unknown>, string, string][] = [
  ["issues.create", api => api.createIssue({ teamId: "team", title: "New" }), "issueCreate", "Linear refused to create the issue."],
  ["issues.update", api => api.updateIssue("issue", { title: "Renamed" }), "issueUpdate", "Linear refused to update the issue."],
  ["issues.archive", api => api.setIssueArchived("issue", true), "issueArchive", "Linear refused to archive the issue."],
  ["issues.unarchive", api => api.setIssueArchived("issue", false), "issueUnarchive", "Linear refused to unarchive the issue."],
  ["comments.create", api => api.createComment("issue", "Done"), "commentCreate", "Linear refused to create the comment."],
  ["labels.create", api => api.createLabel({ teamId: "team", name: "bug" }), "issueLabelCreate", "Linear refused to create the label."],
];

// Each request whose data the client reads a member of, with data that lacks the member and the
// property the reading fails on.
const UNREADABLE: [GraphqlOperation, (api: LinearApi) => Promise<unknown>, unknown, string][] = [
  ["viewer.get", api => api.getViewer(), null, "null (reading 'viewer')"],
  ["organization.get", api => api.getOrganization(), null, "null (reading 'organization')"],
  ["teams.list", api => api.listTeams({ first: 1 }), null, "null (reading 'teams')"],
  ["teams.find", api => api.findTeam("ENG"), {}, "undefined (reading 'nodes')"],
  ["states.list", api => api.listWorkflowStates("team"), { team: null }, "null (reading 'states')"],
  ["labels.list", api => api.listLabels("team"), { team: null }, "null (reading 'labels')"],
  ["members.list", api => api.listTeamMembers("team"), { team: null }, "null (reading 'members')"],
  ["users.list", api => api.listUsers({ first: 1 }), null, "null (reading 'users')"],
  ["team-projects.list", api => api.listProjects({ teamId: "team" }, { first: 1 }), { team: null }, "null (reading 'projects')"],
  ["projects.list", api => api.listProjects({}, { first: 1 }), null, "null (reading 'projects')"],
  ["cycles.list", api => api.listCycles("team", { first: 1 }), { team: null }, "null (reading 'cycles')"],
  ["issues.list", api => api.listIssues({ first: 1 }), null, "null (reading 'issues')"],
  ["issues.search", api => api.searchIssues({ term: "bug", first: 1 }), null, "null (reading 'searchIssues')"],
  ["issues.get", api => api.getIssue("ENG-1"), null, "null (reading 'issue')"],
  ["comments.list", api => api.listComments("issue", { first: 1 }), { issue: null }, "null (reading 'comments')"],
  ["projects.get", api => api.getProject("project"), null, "null (reading 'project')"],
];

// What `call` threw, or undefined where it threw nothing.
async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

// A page of a project's teams that says a further page follows and names no cursor for it.
const cursorless = { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } };

describe("data that lacks what the request was sent for", () => {
  it.each(READ_MUTATIONS.flatMap(([name, call, mutation, refused]) => [
    [name, "says nothing of its success", call, { [mutation]: {} }, new LinearApiError(400, refused)] as const,
    [name, "says null for its success", call, { [mutation]: { success: null } }, new LinearApiError(400, refused)] as const,
    [name, "is null", call, { [mutation]: null }, new TypeError("Cannot read properties of null (reading 'success')")] as const,
    [name, "is absent", call, {}, new TypeError("Cannot read properties of undefined (reading 'success')")] as const,
  ]))("counts %s an error of the API where the payload of a 200 %s, sent once and failing as the client does", async (name, _lacking, call, answer, thrown) => {
    const fetch = answering(data(answer));

    const failure = await thrownBy(() => call(linear()));

    expect(Object.getPrototypeOf(failure)).toBe(Object.getPrototypeOf(thrown));
    expect(failure).toMatchObject({ message: thrown.message, ...(thrown instanceof LinearApiError ? { status: 400 } : {}) });
    expect(sent(fetch)).toEqual([["POST", GRAPHQL]]);
    expect(counted()).toEqual([[name, "error", "api", 200]]);
  });

  it.each(UNREADABLE)("counts %s an error of the API where the data of a 200 lacks what the client reads, sent once", async (name, call, answer, lacking) => {
    const fetch = answering(data(answer));

    const failure = await thrownBy(() => call(linear()));

    expect(Object.getPrototypeOf(failure)).toBe(TypeError.prototype);
    expect(failure).toMatchObject({ message: `Cannot read properties of ${lacking}` });
    expect(sent(fetch)).toEqual([["POST", GRAPHQL]]);
    expect(counted()).toEqual([[name, "error", "api", 200]]);
  });

  // A connection that holds no list of nodes, which the reader of a page would fail on.
  it.each<[GraphqlOperation, (api: LinearApi) => Promise<unknown>, unknown]>([
    ["issues.list", api => api.listIssues({ first: 1 }), { issues: { pageInfo: lastPage } }],
    ["issues.list", api => api.listIssues({ first: 1 }), { issues: { nodes: {}, pageInfo: lastPage } }],
    ["issues.list", api => api.listIssues({ first: 1 }), {}],
    ["issues.search", api => api.searchIssues({ term: "bug", first: 1 }), { searchIssues: { pageInfo: lastPage } }],
    ["users.list", api => api.listUsers({ first: 1 }), { users: {} }],
    ["teams.list", api => api.listTeams({ first: 1 }), { teams: { nodes: null } }],
    ["comments.list", api => api.listComments("issue", { first: 1 }), { issue: { comments: {} } }],
  ])("counts %s an error of the API where its connection holds no list of nodes, sent once", async (name, call, answer) => {
    const fetch = answering(data(answer));

    const failure = await thrownBy(() => call(linear()));

    expect(failure).toBeInstanceOf(LinearApiError);
    expect(failure).toMatchObject({ status: 502, message: "Linear answered a listing with no list." });
    expect(sent(fetch)).toEqual([["POST", GRAPHQL]]);
    expect(counted()).toEqual([[name, "error", "api", 200]]);
  });

  // A cursor that drains such a listing would ask for its first page again.
  it.each<[GraphqlOperation, (api: LinearApi) => Promise<unknown>, string]>([
    ["issues.list", api => api.listIssues({ first: 1 }), "issues"],
    ["issues.search", api => api.searchIssues({ term: "bug", first: 1 }), "searchIssues"],
    ["teams.list", api => api.listTeams({ first: 1 }), "teams"],
  ])("counts %s an error of the API where its page promises another and names no cursor for it", async (name, call, member) => {
    for (const endCursor of [null, ""]) {
      points.length = 0;
      const fetch = answering(data({ [member]: { nodes: [], pageInfo: { hasNextPage: true, endCursor } } }));

      const failure = await thrownBy(() => call(linear()));

      expect(failure).toBeInstanceOf(LinearApiError);
      expect(failure).toMatchObject({ status: 502, message: "Linear answered a page that names no cursor for the page after it." });
      expect(sent(fetch)).toEqual([["POST", GRAPHQL]]);
      expect(counted()).toEqual([[name, "error", "api", 200]]);
    }
  });

  it("counts a listing whose connection holds an empty list as a page", async () => {
    answering(data({ issues: { nodes: [], pageInfo: lastPage } }));

    expect(await linear().listIssues({ first: 1 })).toEqual({ nodes: [], pageInfo: lastPage });
    expect(counted()).toEqual([["issues.list", "success", "", 200]]);
  });

  it("counts a further page of a project's teams an error of the API where its data lacks the project", async () => {
    const fetch = answering(
      data({ projects: { nodes: [project("a")], pageInfo: lastPage } }), data({ project: null }));

    const failure = await thrownBy(() => linear().listProjects({}, { first: 1 }));

    expect(Object.getPrototypeOf(failure)).toBe(TypeError.prototype);
    expect(failure).toMatchObject({ message: "Cannot read properties of null (reading 'teams')" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["projects.list", "success", "", 200], ["project-teams.list", "error", "api", 200]]);
  });

  it.each<[string, unknown, string]>([
    ["its projects are no list", { nodes: {}, pageInfo: lastPage }, "Linear answered a listing with no list."],
    ["its page promises another and names no cursor for it", { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
      "Linear answered a page that names no cursor for the page after it."],
  ])("counts a listing of projects an error of the API where %s, before the teams of any project are asked for", async (_name, projects, message) => {
    const fetch = answering(data({ projects }));

    const failure = await thrownBy(() => linear().listProjects({}, { first: 1 }));

    expect(failure).toBeInstanceOf(LinearApiError);
    expect(failure).toMatchObject({ status: 502, message });
    expect(sent(fetch)).toEqual([["POST", GRAPHQL]]);
    expect(counted()).toEqual([["projects.list", "error", "api", 200]]);
  });

  it.each<[GraphqlOperation, (api: LinearApi) => Promise<unknown>, string]>([
    ["comments.delete", api => api.deleteComment("comment"), "commentDelete"],
    ["issues.delete", api => api.deleteIssue("issue"), "issueDelete"],
    ["labels.delete", api => api.deleteLabel("label"), "issueLabelDelete"],
  ])("counts %s a success where a 200 holds no payload: the answer of a deletion is not read", async (name, call, mutation) => {
    answering(data({ [mutation]: null }));

    await expect(call(linear())).resolves.toBeUndefined();

    expect(counted()).toEqual([[name, "success", "", 200]]);
  });

  it("counts a lookup a success where Linear answers null for what is not there", async () => {
    answering(data({ issue: null }));

    await expect(linear().getIssue("ENG-404")).resolves.toBeNull();

    expect(counted()).toEqual([["issues.get", "success", "", 200]]);
  });

  it("counts data the client refuses inside a failed status by the status", async () => {
    answering(Response.json({ data: { issueCreate: {} } }, { status: 500 }));

    await expect(linear().createIssue({ teamId: "team", title: "New" })).rejects.toMatchObject({ status: 500, message: "500 " });

    expect(counted()).toEqual([["issues.create", "error", "http", 500]]);
  });
});

describe("a page of a project's teams that names no cursor for the page after it", () => {
  it("counts the listing of projects an error of the API, and still asks for the teams of the project before it", async () => {
    const fetch = answering(
      data({ projects: { nodes: [project("a"), { id: "b", teams: cursorless }], pageInfo: lastPage } }),
      data({ project: { teams: empty } }));

    const failure = await thrownBy(() => linear().listProjects({}, { first: 2 }));

    expect(Object.getPrototypeOf(failure)).toBe(LinearApiError.prototype);
    expect(failure).toMatchObject({ status: 500, message: "Linear returned an invalid project teams cursor." });
    // The teams of the project before it are asked for all the same, and counted when answered.
    await vi.waitFor(() => expect(points).toHaveLength(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["projects.list", "error", "api", 200], ["project-teams.list", "success", "", 200]]);
  });

  it("counts the further page an error of the API, and the listing of projects a success", async () => {
    const fetch = answering(
      data({ projects: { nodes: [project("a")], pageInfo: lastPage } }), data({ project: { teams: cursorless } }));

    const failure = await thrownBy(() => linear().listProjects({}, { first: 1 }));

    expect(Object.getPrototypeOf(failure)).toBe(LinearApiError.prototype);
    expect(failure).toMatchObject({ status: 500, message: "Linear returned an invalid project teams cursor." });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["projects.list", "success", "", 200], ["project-teams.list", "error", "api", 200]]);
  });

  it("counts a page a success where it is the last and names no cursor", async () => {
    answering(data({ projects: { nodes: [{ id: "a", teams: empty }], pageInfo: lastPage } }));

    await expect(linear().listProjects({}, { first: 1 })).resolves.toMatchObject({ nodes: [{ id: "a" }] });

    expect(counted()).toEqual([["projects.list", "success", "", 200]]);
  });
});

describe("how a token request is counted", () => {
  it("counts an OAuth error inside a 200 as an error of the API, and throws it", async () => {
    const fetch = answering(Response.json({ error: "invalid_grant", error_description: "revoked" }));
    await expect(refresh()).rejects.toMatchObject({
      name: "LinearApiError", status: 400, message: "invalid_grant: revoked", isAuthError: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.refresh", "error", "api", 200]]);
  });

  it("counts a 200 with no access token as an error of the API", async () => {
    answering(Response.json({ token_type: "Bearer" }));
    await expect(refresh()).rejects.toThrow("Linear OAuth token exchange failed");
    expect(counted()).toEqual([["token.refresh", "error", "api", 200]]);
  });

  it("counts a refused grant by its status, and sends it once", async () => {
    const fetch = answering(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(refresh()).rejects.toMatchObject({ status: 400, message: "invalid_grant", isAuthError: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.refresh", "error", "http", 400]]);
  });

  it("sends an exchange once when Linear is unavailable, following no redirect", async () => {
    const fetch = answering(new Response("", { status: 503, headers: { "Retry-After": "0" } }));
    await expect(exchangeAuthCode({ ...client, code: "code", redirectUri: "https://gadgets.example/oauth" }))
      .rejects.toMatchObject({ name: "LinearApiError", status: 503 });
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(["manual"]);
    expect(counted()).toEqual([["token.exchange", "error", "http", 503]]);
  });

  it("counts a revocation Linear answers 400, as it does for a token already revoked, as a success with that status", async () => {
    const fetch = answering(new Response("", { status: 400 }));
    await expect(revokeToken("access")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.revoke", "success", "", 400]]);
  });

  it.each<[number, string, unknown[]]>([
    [302, "Found", ["error", "http", 302]],
    [401, "Unauthorized", ["error", "http", 401]],
    [403, "Forbidden", ["error", "http", 403]],
    [404, "Not Found", ["error", "http", 404]],
    [422, "Unprocessable Entity", ["error", "http", 422]],
    [429, "Too Many Requests", ["refused", "rate", 429]],
    [500, "Internal Server Error", ["error", "http", 500]],
  ])("counts a revocation Linear answers %i by that status, sends it once and throws it", async (status, statusText, outcome) => {
    const fetch = answering(new Response(null, { status, statusText }));
    await expect(revokeToken("access")).rejects.toMatchObject({
      name: "LinearApiError", status, message: `Failed to revoke token: ${statusText}`,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.revoke", ...outcome]]);
  });

  it.each([200, 400, 500])("sends a revocation Linear answers %i as one form post that follows no redirect", async status => {
    const fetch = answering(new Response(null, { status }));
    await revokeToken("access").catch(() => undefined);
    expect(fetch.mock.calls).toEqual([[REVOKE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=access",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    }]]);
  });

  it("counts a revocation the network fails as a network error, sent once, and throws what fetch threw", async () => {
    const failure = new TypeError("fetch failed");
    const fetch = answering(failure);
    await expect(revokeToken("access")).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.revoke", "error", "network", 0]]);
  });

  it("counts both tokens of an account that Linear answers 400 as revoked, and logs no failure", async () => {
    const fetch = answering(new Response("", { status: 400 }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { account, stored } = accountHolding({ accessToken: "access", refreshToken: "refresh" });
    await account.revoke();
    expect(fetch.mock.calls.map(([url, init]) => [url, init.body]))
      .toEqual([[REVOKE, "token=access"], [REVOKE, "token=refresh"]]);
    expect(counted()).toEqual([["token.revoke", "success", "", 400], ["token.revoke", "success", "", 400]]);
    expect(logged).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  it("counts a refresh token's failed revocation as an error after an access token already revoked, and logs it", async () => {
    const fetch = answering(new Response("", { status: 400 }), new Response("", { status: 500 }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { account, stored } = accountHolding({ accessToken: "access", refreshToken: "refresh" });
    await account.revoke();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([["token.revoke", "success", "", 400], ["token.revoke", "error", "http", 500]]);
    expect(logged.mock.calls).toEqual([[expect.objectContaining({ event: "oauth.token.revoke.failed" })]]);
    expect(stored.size).toBe(0);
  });

  it("throws a revocation Linear fails with a status a retry would send again, sent once", async () => {
    const fetch = answering(new Response("", { status: 503, headers: { "Retry-After": "0" } }));
    await expect(revokeToken("access")).rejects.toMatchObject({ name: "LinearApiError", status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.revoke", "error", "http", 503]]);
  });
});
