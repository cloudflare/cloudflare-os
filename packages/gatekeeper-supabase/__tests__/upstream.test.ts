// The requests this gatekeeper sends to Supabase, the name each is counted under, and what the
// gatekeeper decides about a call that the client cannot know: which request is sent again, an
// error inside a success, and a result the gatekeeper refuses though Supabase gave it. These drive
// the real API client against a stubbed fetch and read the points it writes.

import { env as bindings } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pickers' classes are decorated for RPC validation, which a test run does not compile.
vi.mock("capnweb-validate", () => ({ validateRpc: () => (value: unknown) => value }));

import {
  SupabaseApi, SupabaseApiError, exchangeAuthCode, refreshAccessToken, revokeRefreshToken,
} from "../src/supabase-api";
import { SupabaseOrganizationConfiguratorUI, SupabaseProjectConfiguratorUI } from "../src/supabase-configurators";
import { describeTable } from "../src/supabase-introspection";
import { SUPABASE_ROUTES, SUPABASE_TOKEN_OPERATIONS, supabaseUpstream } from "../src/supabase-upstream";

const API = "https://api.supabase.com/v1";
const TOKEN = `${API}/oauth/token`;
const REVOKE = `${API}/oauth/revoke`;
const REF = "abcdefghijklmnopqrst";
const QUERY = `${API}/projects/${REF}/database/query`;

type Point = { blobs?: unknown[]; doubles?: unknown[] };
type Sent = [url: string, init: RequestInit];

const ambient = bindings as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
let points: Point[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void points.push(point) };
  ambient.SUBSERVICE_METRICS = "true";
  // No wait between the sends of a request whose attempt threw.
  vi.spyOn(Math, "random").mockReturnValue(0);
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

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// An answer that asks for the request again at once.
const failing = (status: number) => json({ message: "try later" }, status, { "Retry-After": "0" });
const supabase = () => new SupabaseApi(async () => "token");

// Each kind of request the gatekeeper makes to the Management API: its method, its URL, the name
// it is counted under, and the method of the client that sends it.
const REQUESTS: [method: string, url: string, name: string, call: (api: SupabaseApi) => Promise<unknown>][] = [
  ["GET", `${API}/organizations`, "organizations.list", api => api.listOrganizations()],
  ["GET", `${API}/projects`, "projects.list", api => api.listProjects()],
  ["GET", `${API}/projects/${REF}`, "projects.get", api => api.getProject(REF)],
  ["POST", `${QUERY}/read-only`, "query.read-only", api => api.runReadOnlyQuery(REF, "select 1")],
  ["POST", QUERY, "query.create", api => api.runQuery(REF, "delete from notes")],
  ["GET", `${API}/projects/${REF}/functions`, "functions.list", api => api.listFunctions(REF)],
  ["GET", `${API}/projects/${REF}/functions/hello/body`, "body.get", api => api.getFunctionBody(REF, "hello")],
  ["GET", `${API}/projects/${REF}/storage/buckets`, "buckets.list", api => api.listStorageBuckets(REF)],
  ["GET", `${API}/projects/${REF}/health?services=auth&services=db`, "health.get",
    api => api.getServicesHealth(REF, ["auth", "db"])],
];

// Each request to the OAuth endpoints: its name, its URL, the function that sends it, and a
// successful answer.
const grant = { access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" };
const exchange = () => exchangeAuthCode("code", "client", "secret", "https://gadgets.example/oauth");
const refresh = () => refreshAccessToken("refresh", "client", "secret");
const revoke = () => revokeRefreshToken("refresh", "client", "secret");
const TOKEN_REQUESTS: [name: string, url: string, call: () => Promise<unknown>, answer: Response][] = [
  ["token.exchange", TOKEN, exchange, json(grant)],
  ["token.refresh", TOKEN, refresh, json(grant)],
  ["token.revoke", REVOKE, revoke, new Response(null, { status: 204 })],
];

describe("the names of Supabase's requests", () => {
  it("counts every request under the source and service of the vendor", () => {
    expect(supabaseUpstream.vendorId).toBe("supabase");
    expect(supabaseUpstream.source).toBe("gatekeeper.supabase.api");
  });

  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(supabaseUpstream.operationOf(method, url)).toBe(name);
  });

  it.each(REQUESTS)("sends %s %s and counts it as %s", async (method, url, name, call) => {
    const fetch = answering(json([]));
    await call(supabase());
    expect(sent(fetch)).toEqual([[method, url]]);
    expect(counted()).toEqual([[name, "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["supabase"]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(["gatekeeper.supabase.api"]);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(SUPABASE_ROUTES)).toHaveLength(5);
    expect(unreachedRouteEnds(SUPABASE_ROUTES, REQUESTS)).toEqual([]);
  });

  it("names a path the tree does not hold, and another host, by the method alone", () => {
    expect(supabaseUpstream.operationOf("GET", `${API}/projects/${REF}/branches`)).toBe("GET");
    expect(supabaseUpstream.operationOf("POST", `${API}/projects/${REF}/database/backups/restore-pitr`)).toBe("POST");
    expect(supabaseUpstream.operationOf("DELETE", `${API}/snippets/1`)).toBe("DELETE");
    expect(supabaseUpstream.operationOf("GET", "https://api.supabase.example/v1/projects")).toBe("GET");
  });

  it("builds no name from what a path holds in place of an ID", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    expect(supabaseUpstream.operationOf("GET", `${API}/projects/Some_Ref`)).toBe("projects.get");
    expect(supabaseUpstream.operationOf("GET", `${API}/projects/health/functions/body/body`)).toBe("body.get");
    expect(words.has(supabaseUpstream.operationOf("POST", `${API}/projects/database/database/query`))).toBe(true);
    expect(supabaseUpstream.operationOf("GET", `${API}/projects/${REF}/Some_Slug`)).toBe("GET");
  });

  it("gives no request to the OAuth endpoints a name from its URL", () => {
    expect(supabaseUpstream.operationOf("POST", TOKEN)).toBe("POST");
    expect(supabaseUpstream.operationOf("POST", REVOKE)).toBe("POST");
  });

  it.each(TOKEN_REQUESTS)("counts a request to the OAuth endpoints under %s", async (name, url, call, answer) => {
    const fetch = answering(answer);
    await call();
    expect(sent(fetch)).toEqual([["POST", url]]);
    expect(counted()).toEqual([[name, "success", "", answer.status]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["supabase"]);
  });

  it("sends a request for every name of the union, and lists none twice", () => {
    expect(TOKEN_REQUESTS.map(([name]) => name).toSorted()).toEqual(SUPABASE_TOKEN_OPERATIONS.toSorted());
    expect(new Set(SUPABASE_TOKEN_OPERATIONS).size).toBe(SUPABASE_TOKEN_OPERATIONS.length);
  });
});

describe("how a request to Supabase is sent", () => {
  it("gives every request, a SQL statement and a token's included, 30 seconds for each attempt", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answering(json([]), json([]), json([]), json(grant), new Response(null, { status: 204 }));
    await supabase().listProjects();
    await supabase().runReadOnlyQuery(REF, "select 1");
    await supabase().runQuery(REF, "delete from notes");
    await refresh();
    await revoke();
    expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000], [30_000], [30_000]]);
  });

  it("follows no redirect, and fails on one", async () => {
    const fetch = answering(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
    await expect(supabase().getProject(REF)).rejects.toMatchObject({ name: "SupabaseApiError", status: 302 });
    await expect(refresh()).rejects.toMatchObject({ name: "SupabaseApiError", status: 302 });
    await expect(revoke()).rejects.toMatchObject({ name: "SupabaseApiError", status: 302 });
    expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(["manual", "manual", "manual"]);
    expect(counted()).toEqual([
      ["projects.get", "error", "http", 302], ["token.refresh", "error", "http", 302],
      ["token.revoke", "error", "http", 302],
    ]);
  });

  it.each([
    ["a rate limit", 429, ["refused", "rate", 429]],
    ["an outage", 503, ["error", "http", 503]],
  ])("sends a GET three times when Supabase keeps answering %s", async (_name, status, outcome) => {
    const fetch = answering(failing(status));
    await expect(supabase().listProjects()).rejects.toMatchObject({
      name: "SupabaseApiError", status, message: "try later",
    });
    expect(sent(fetch)).toEqual([["GET", `${API}/projects`], ["GET", `${API}/projects`], ["GET", `${API}/projects`]]);
    expect(counted()).toEqual([1, 2, 3].map(() => ["projects.list", ...outcome]));
  });

  it("answers a GET with what Supabase gives once it recovers, asking for the token before each send", async () => {
    const tokens = ["token-1", "token-2"];
    const fetch = answering(failing(502), json([{ slug: "acme", name: "Acme" }]));
    await expect(new SupabaseApi(async () => tokens.shift() ?? "none").listOrganizations())
      .resolves.toEqual([{ slug: "acme", name: "Acme" }]);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init.headers).get("Authorization")))
      .toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([["organizations.list", "error", "http", 502], ["organizations.list", "success", "", 200]]);
  });

  it("sends a GET three times when the network fails, and throws what fetch threw", async () => {
    const failure = new TypeError("fetch failed");
    const fetch = answering(failure);
    await expect(supabase().listFunctions(REF)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual([1, 2, 3].map(() => ["functions.list", "error", "network", 0]));
  });

  it.each<[string, string, (api: SupabaseApi) => Promise<unknown>]>([
    ["a statement that may write", "query.create", api => api.runQuery(REF, "insert into notes values ($1)", ["a"])],
    ["a read-only statement", "query.read-only", api => api.runReadOnlyQuery(REF, "select $1", ["a"])],
  ])("sends %s once, whatever comes of it", async (_name, name, call) => {
    const failure = new TypeError("fetch failed");
    const fetch = answering(failing(429), failing(503), failure);
    await expect(call(supabase())).rejects.toMatchObject({ name: "SupabaseApiError", status: 429 });
    await expect(call(supabase())).rejects.toMatchObject({ name: "SupabaseApiError", status: 503 });
    await expect(call(supabase())).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(counted()).toEqual([
      [name, "refused", "rate", 429], [name, "error", "http", 503], [name, "error", "network", 0],
    ]);
  });

  it("declares a statement that may write as never sent again, and leaves a read-only one to the client's rule", async () => {
    const read = vi.spyOn(supabaseUpstream, "read");
    answering(json([]));
    await supabase().runQuery(REF, "delete from notes");
    await supabase().runReadOnlyQuery(REF, "select 1");
    expect(read.mock.calls.map(([, init]) => init?.retry)).toEqual([null, undefined]);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    ["an exchange", "token.exchange", exchange],
    ["a refresh", "token.refresh", refresh],
    ["a revocation", "token.revoke", revoke],
  ])("sends %s once, whatever comes of it", async (_name, name, call) => {
    const failure = new TypeError("fetch failed");
    const fetch = answering(failing(503), failure);
    await expect(call()).rejects.toMatchObject({ name: "SupabaseApiError", status: 503 });
    await expect(call()).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(counted()).toEqual([[name, "error", "http", 503], [name, "error", "network", 0]]);
  });
});

describe("how an answer of Supabase is counted", () => {
  it("counts a rejected token by its status, as the auth error callers act on", async () => {
    answering(json({ message: "Unauthorized" }, 401));
    const error = await supabase().listProjects().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SupabaseApiError);
    expect(error).toMatchObject({ status: 401, message: "Unauthorized", isAuthError: true });
    expect(counted()).toEqual([["projects.list", "error", "http", 401]]);
  });

  it("counts a statement Postgres refused by its status, and throws its message", async () => {
    answering(json({ message: "relation \"notes\" does not exist" }, 400));
    await expect(supabase().runQuery(REF, "delete from notes")).rejects.toMatchObject({
      name: "SupabaseApiError", status: 400, message: "relation \"notes\" does not exist",
    });
    expect(counted()).toEqual([["query.create", "error", "http", 400]]);
  });

  // Each listing the client asks for: the name it is counted under, and the method that asks.
  const LISTINGS: [name: string, call: (api: SupabaseApi) => Promise<unknown>][] = [
    ["organizations.list", api => api.listOrganizations()],
    ["projects.list", api => api.listProjects()],
    ["functions.list", api => api.listFunctions(REF)],
    ["buckets.list", api => api.listStorageBuckets(REF)],
    ["health.get", api => api.getServicesHealth(REF, ["auth", "db"])],
  ];

  describe.each(LISTINGS)("a listing counted as %s", (name, call) => {
    it.each<[string, unknown]>([
      ["an object", {}],
      ["null", null],
      ["an object that holds a list", { items: [{ slug: "acme", name: "Acme" }] }],
    ])("is an error of the API where Supabase answers %s, thrown and not asked for again", async (_kind, body) => {
      const fetch = answering(json(body));
      await expect(call(supabase())).rejects.toMatchObject({
        name: "SupabaseApiError", status: 502, message: "Supabase answered a listing with no list.",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([[name, "error", "api", 200]]);
    });

    it.each<[string, unknown[]]>([
      ["an empty list", []],
      ["a list", [{ slug: "acme", name: "Acme" }, { slug: "globex", name: "Globex" }]],
    ])("is a success where Supabase answers %s", async (_kind, body) => {
      answering(json(body));
      await expect(call(supabase())).resolves.toEqual(body);
      expect(counted()).toEqual([[name, "success", "", 200]]);
    });
  });

  it.each<[string, string, string, () => { list(query: string): Promise<unknown> }, unknown, unknown]>([
    ["projects", "projects.list", `${API}/projects`,
      () => {
        const picker = new SupabaseProjectConfiguratorUI(async () => "token");
        return { list: query => picker.listProjects(query) };
      },
      { ref: REF, name: "Acme notes", organization_slug: "acme", region: "eu-west-1", status: "ACTIVE_HEALTHY", created_at: "" },
      { value: REF, title: "Acme notes", subtitle: "acme · eu-west-1", meta: REF }],
    ["organizations", "organizations.list", `${API}/organizations`,
      () => {
        const picker = new SupabaseOrganizationConfiguratorUI(async () => "token");
        return { list: query => picker.listOrganizations(query) };
      },
      { slug: "acme", name: "Acme" },
      { value: "acme", title: "Acme", subtitle: "acme" }],
  ])("asks again for the %s of a picker that was answered no list, and keeps the list it then gets", async (_kind, name, url, pick, row, option) => {
    const fetch = answering(json({}), json([row]));
    const picker = pick();
    await expect(picker.list("")).rejects.toMatchObject({
      name: "SupabaseApiError", status: 502, message: "Supabase answered a listing with no list.",
    });
    await expect(picker.list("")).resolves.toEqual([option]);
    await expect(picker.list("ac")).resolves.toEqual([option]);
    expect(sent(fetch)).toEqual([["GET", url], ["GET", url]]);
    expect(counted()).toEqual([[name, "error", "api", 200], [name, "success", "", 200]]);
  });

  it("counts a result over the size cap as the success it was, and refuses it", async () => {
    answering(new Response(JSON.stringify([{ body: "x".repeat(16 * 1024 * 1024) }])));
    await expect(supabase().runReadOnlyQuery(REF, "select body from notes"))
      .rejects.toThrow("Query returned too much data (~16 MB across 1 rows).");
    expect(counted()).toEqual([["query.read-only", "success", "", 200]]);
  });

  it.each<[string, unknown]>([["an object", {}], ["nothing", null]])(
    "counts a read-only query answered 200 with %s as an error of the API, not as zero rows", async (_what, body) => {
      const fetch = answering(Response.json(body));
      const thrown = await supabase().runReadOnlyQuery(REF, "select 1").catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(SupabaseApiError);
      expect(thrown).toMatchObject({ status: 502, message: "Supabase answered a query with no list of rows." });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([["query.read-only", "error", "api", 200]]);
    });

  it("counts a query's success that is no JSON as an answer that could not be parsed", async () => {
    answering(new Response("<html>", { status: 200 }));
    await expect(supabase().runReadOnlyQuery(REF, "select 1")).rejects.toBeInstanceOf(SyntaxError);
    expect(counted()).toEqual([["query.read-only", "error", "parse", 200]]);
  });

  it("writes one point for the batch of queries that describes a table", async () => {
    const fetch = answering(
      json([{ schema: "public", name: "notes", kind: "table", rls_enabled: true, approx_rows: 3, comment: null }]),
      json([]),
    );
    await expect(describeTable(supabase(), REF, "public", "notes")).resolves.toMatchObject({
      name: "notes", kind: "table", columns: [], primaryKey: [], foreignKeys: [],
    });
    expect(sent(fetch)).toEqual([1, 2, 3, 4].map(() => ["POST", `${QUERY}/read-only`]));
    expect(counted()).toEqual([["query.read-only", "success", "", 200]]);
    expect(columnOf(SUBSERVICE_V1_SLOTS.calls)).toEqual([4]);
  });

  it("writes nothing an answer, a statement or a path holds", async () => {
    answering(json({ message: "Secret refusal about Some_Table" }, 403));
    await expect(new SupabaseApi(async () => "secret-token").runReadOnlyQuery("Some_Ref", "select secret from Some_Table"))
      .rejects.toThrow("Secret refusal");
    const written = JSON.stringify(points);
    expect(points).toHaveLength(1);
    for (const secret of ["Some_Ref", "Some_Table", "secret", "Secret", "api.supabase.com"]) {
      expect(written).not.toContain(secret);
    }
  });
});

describe("how a request to the OAuth endpoints is counted", () => {
  it("counts a 200 that holds no tokens as an error of the API, and throws it", async () => {
    const fetch = answering(json({ error: "invalid_grant", error_description: "revoked" }));
    await expect(refresh()).rejects.toMatchObject({
      name: "SupabaseApiError", status: 400, message: "Supabase OAuth token response was missing tokens.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.refresh", "error", "api", 200]]);
  });

  it("counts a 200 that holds one token of the two as an error of the API", async () => {
    answering(json({ access_token: "access" }));
    await expect(exchange()).rejects.toThrow("Supabase OAuth token response was missing tokens.");
    expect(counted()).toEqual([["token.exchange", "error", "api", 200]]);
  });

  it("counts a refused grant by its status, as the auth error callers act on", async () => {
    const fetch = answering(json({ error: "invalid_grant", error_description: "revoked" }, 400));
    await expect(refresh()).rejects.toMatchObject({
      name: "SupabaseApiError", status: 400, message: "invalid_grant: revoked", isAuthError: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(counted()).toEqual([["token.refresh", "error", "http", 400]]);
  });

  it("counts a revocation of a token Supabase does not know as a success, and does not throw", async () => {
    answering(json({ message: "not found" }, 404));
    await expect(revoke()).resolves.toBeUndefined();
    expect(counted()).toEqual([["token.revoke", "success", "", 404]]);
  });

  it("counts a revocation Supabase fails by its status, and throws it", async () => {
    answering(json({ message: "try later" }, 500));
    await expect(revoke()).rejects.toMatchObject({ name: "SupabaseApiError", status: 500 });
    expect(counted()).toEqual([["token.revoke", "error", "http", 500]]);
  });

  it("writes nothing a token request or its answer holds", async () => {
    answering(json({ access_token: "Secret_Access", refresh_token: "Secret_Refresh" }));
    await expect(exchangeAuthCode("Secret_Code", "Secret_Client", "Secret_Key", "https://gadgets.example/oauth"))
      .resolves.toMatchObject({ accessToken: "Secret_Access" });
    expect(points).toHaveLength(1);
    expect(JSON.stringify(points)).not.toMatch(/Secret|gadgets\.example|api\.supabase\.com/);
  });
});
