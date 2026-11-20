// The requests this gatekeeper makes to ZoomInfo and the name each is counted under, whatever API
// root a deployment configures, and what the gatekeeper decides about a call that the client
// cannot know: an error inside a success, and which requests are sent once. The API client and
// the token requests are driven against a stubbed fetch, and the points they write are read.

import { env } from "cloudflare:workers";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ZoomInfoApi, ZoomInfoApiError, exchangeAuthCode, isGrantRefused, isRefreshToken, readIdToken, refreshAccessToken,
} from "../src/zoominfo-api";
import {
  DEFAULT_API_BASE_URL, SHAPE_OPERATIONS, TOKEN_OPERATIONS, zoominfoRoutes, zoominfoUpstream,
  zoominfoUpstreamAt,
} from "../src/zoominfo-upstream";

const API = DEFAULT_API_BASE_URL;
const TOKEN_URL = "https://api.zoominfo.com/gtm/oauth/v1/token";
// An API root and a token URL of a deployment's own.
const OWN_API = "https://zoominfo.proxy.example/tenant-9/gtm";
const OWN_TOKEN_URL = "https://login.proxy.example/tenant-9/token";

/** Every kind of request the gatekeeper makes under the API root, with the name it is counted under. */
const PATHS: [method: string, path: string, name: string][] = [
  ["GET", "/data/v1/lookup/industries?filter%5Bcategory%5D=Software", "lookup.get"],
  ["GET", "/data/v1/lookup/enrich?filter%5Bentity%5D=company&filter%5BfieldType%5D=output", "lookup.enrich"],
  ["POST", "/data/v1/companies/search?page%5Bnumber%5D=1&page%5Bsize%5D=25", "companies.search"],
  ["POST", "/data/v1/companies/enrich", "companies.enrich"],
  ["POST", "/data/v1/companies/corporate-hierarchy/enrich", "corporate-hierarchy.enrich"],
  ["POST", "/data/v1/companies/hashtags/enrich", "hashtags.enrich"],
  ["POST", "/data/v1/contacts/search", "contacts.search"],
  ["POST", "/data/v1/contacts/enrich", "contacts.enrich"],
  ["POST", "/data/v1/intent/search", "intent.search"],
  ["POST", "/data/v1/intent/enrich?page%5Bnumber%5D=2", "intent.enrich"],
  ["POST", "/data/v1/scoops/search", "scoops.search"],
  ["POST", "/data/v1/scoops/enrich", "scoops.enrich"],
  ["POST", "/data/v1/news/search", "news.search"],
  ["POST", "/data/v1/news/enrich", "news.enrich"],
  ["GET", "/data/v1/users/usage", "users.usage"],
  ["GET", "/copilot/v1/companies/lookalikes?filter%5BcompanyId%5D=7", "companies.lookalikes"],
  ["POST", "/copilot/v1/companies/insights", "companies.insights"],
  ["GET", "/copilot/v1/companies/7/account-summary", "account-summary.get"],
  ["POST", "/copilot/v1/companies/7/account-summary/actions/ask", "actions.ask"],
  ["GET", "/copilot/v1/contacts/lookalikes?filter%5BreferencePersonId%5D=11", "contacts.lookalikes"],
  ["GET", "/copilot/v1/contacts/recommendations?filter%5BuseCaseType%5D=PROSPECTING", "contacts.recommendations"],
];

// The table's requests under one API root.
const under = (root: string) => PATHS.map(([method, path, name]): [string, string, string] => [method, root + path, name]);
const NAMES = new Set(PATHS.map(([, , name]) => name));

describe("the names of ZoomInfo's requests", () => {
  it.each(under(API))("names %s %s as %s", (method, url, name) => {
    expect(zoominfoUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(zoominfoRoutes(API))).toHaveLength(20);
    expect(unreachedRouteEnds(zoominfoRoutes(API), under(API))).toEqual([]);
  });

  it("names each request the tree cannot spell, and none of them twice", () => {
    const shaped = PATHS.map(([, , name]) => name).filter(name => SHAPE_OPERATIONS.some(shape => shape === name));
    expect(shaped.toSorted()).toEqual(SHAPE_OPERATIONS.toSorted());
  });

  it("names a path the tree does not hold, and another host, by the method alone", () => {
    expect(zoominfoUpstream.operationOf("GET", `${API}/data/v1/webhooks`)).toBe("GET");
    expect(zoominfoUpstream.operationOf("DELETE", `${API}/data/v1/companies/search`)).toBe("DELETE");
    expect(zoominfoUpstream.operationOf("POST", TOKEN_URL)).toBe("POST");
    expect(zoominfoUpstream.operationOf("GET", "https://api.zoominfo.example/gtm/data/v1/users/usage")).toBe("GET");
  });

  it("builds no name from what a path holds in place of an ID", () => {
    expect(zoominfoUpstream.operationOf("GET", `${API}/data/v1/lookup/Secret_Field`)).toBe("lookup.get");
    expect(zoominfoUpstream.operationOf("GET", `${API}/data/v1/lookup/a%2Fb%3Ac`)).toBe("lookup.get");
    expect(zoominfoUpstream.operationOf("GET", `${API}/copilot/v1/companies/Secret_Company/account-summary`))
      .toBe("account-summary.get");
    expect(zoominfoUpstream.operationOf("POST", `${API}/copilot/v1/companies/insights/account-summary/actions/ask`))
      .toBe("actions.ask");
    expect(zoominfoUpstream.operationOf("GET", `${API}/copilot/v1/Secret_Company`)).toBe("GET");
  });

  it.each([OWN_API, `${OWN_API}/`, "https://ZoomInfo.Proxy.example:443/tenant-9/gtm", "https://proxy.example"])(
    "gives the requests under the API root %s the names of the default root", root => {
      const upstream = zoominfoUpstreamAt(root);
      const base = new URL(root).href.replace(/\/+$/, "");
      const names = under(base).map(([method, url]) => upstream.operationOf(method, url));
      expect(names).toEqual(PATHS.map(([, , name]) => name));
      expect(unreachedRouteEnds(zoominfoRoutes(root), under(base))).toEqual([]);
      // A request outside that root, the default one included, has no name there.
      expect(upstream.operationOf("GET", `${API}/data/v1/users/usage`)).toBe("GET");
      expect(upstream.operationOf("GET", `${base}-other/data/v1/users/usage`)).toBe("GET");
    });

  it("is the one upstream under the default root, and of the same vendor under any other", () => {
    expect(zoominfoUpstreamAt(API)).toBe(zoominfoUpstream);
    expect(zoominfoUpstreamAt(OWN_API).source).toBe("gatekeeper.zoominfo.api");
    expect(zoominfoUpstream.vendorId).toBe("zoominfo");
  });

  it("names no request under an API root that is no URL", () => {
    expect(zoominfoRoutes("not a url")).toEqual([]);
    expect(zoominfoUpstreamAt("not a url").operationOf("GET", `${API}/data/v1/users/usage`)).toBe("GET");
  });
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

type Sent = [url: string, init: RequestInit];

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

const doc = (data: unknown, status = 200) => Response.json({ data }, { status });
// A failure the default retry sends an idempotent request again after, with no wait.
const transient = (status: number) => new Response("", { status, headers: { "Retry-After": "0" } });
const zoominfo = (root?: string) => new ZoomInfoApi(async () => "access-secret", root);
// An ID token with `claims` and a signature nobody checks, as the token endpoint returns one.
const idToken = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.signature`;
// A grant as a code's exchange is sent for one: with a refresh token, and an ID token that names
// its user to the client the requests below are sent as.
const grant = {
  access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600, scope: "api:data:company",
  id_token: idToken({ sub: "user-1", aud: "client" }),
};
const exchange = (tokenUrl = TOKEN_URL) =>
  exchangeAuthCode("code-secret", "verifier-secret", "https://gadgets.example/oauth", "client", "client-secret", tokenUrl);
const refresh = (tokenUrl = TOKEN_URL) =>
  refreshAccessToken("refresh-secret", ["api:data:company"], "client", "client-secret", tokenUrl);

describe("the points of ZoomInfo's requests", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];
  // The lines the token requests log, by level.
  let logged: Record<"info" | "error", MockInstance<Console["info"]>>;

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => void (point && points.push(point)) };
    ambient.SUBSERVICE_METRICS = "true";
    logged = {
      info: vi.spyOn(console, "info").mockImplementation(() => undefined),
      error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    };
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Each point written, as its operation, outcome, reason and HTTP status.
  function counted() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
      SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  // One column of each point written.
  function columnOf(slot: BlobSlot | DoubleSlot) {
    return points.map(point => column(point, slot));
  }

  describe("of the API", () => {
    it("counts a read and a search under the vendor's source and service, by their routes", async () => {
      const fetch = answering(doc([]));
      await zoominfo().get("/data/v1/lookup/industries", { "filter[category]": "Software" });
      await zoominfo().post("/data/v1/companies/search", "CompanySearch", {}, { "page[number]": 1 });
      expect(sent(fetch)).toEqual([
        ["GET", `${API}/data/v1/lookup/industries?filter%5Bcategory%5D=Software`],
        ["POST", `${API}/data/v1/companies/search?page%5Bnumber%5D=1`],
      ]);
      expect(counted()).toEqual([["lookup.get", "success", "", 200], ["companies.search", "success", "", 200]]);
      expect(columnOf(SUBSERVICE_V1_SLOTS.source)).toEqual(["gatekeeper.zoominfo.api", "gatekeeper.zoominfo.api"]);
      expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["zoominfo", "zoominfo"]);
    });

    it.each<[string, () => Response]>([
      ["a login page", () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } })],
      ["JSON that cannot be read", () => new Response("{\"data\":", { headers: { "Content-Type": "application/vnd.api+json" } })],
      ["a list", () => Response.json([])],
    ])("counts an enrichment answered 200 with %s as a body that could not be read, sent once", async (_name, answer) => {
      const fetch = answering(answer());
      const thrown = await zoominfo().post("/data/v1/companies/enrich", "CompanyEnrich", {}).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ZoomInfoApiError);
      expect(thrown).toMatchObject({ status: 502, message: "ZoomInfo answered with no JSON:API document." });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([["companies.enrich", "error", "parse", 200]]);
    });

    it("counts an enrichment that matched nothing as a success", async () => {
      answering(doc([]));
      await expect(zoominfo().post("/data/v1/companies/enrich", "CompanyEnrich", {})).resolves.toMatchObject({ data: [] });
      expect(counted()).toEqual([["companies.enrich", "success", "", 200]]);
    });

    it("counts the requests under a deployment's own API root by the same names", async () => {
      const fetch = answering(doc([]));
      await zoominfo(`${OWN_API}/`).get("/copilot/v1/companies/7/account-summary");
      await zoominfo(OWN_API).post("/data/v1/companies/enrich", "CompanyEnrich", {});
      expect(sent(fetch)).toEqual([
        ["GET", `${OWN_API}/copilot/v1/companies/7/account-summary`],
        ["POST", `${OWN_API}/data/v1/companies/enrich`],
      ]);
      expect(counted()).toEqual([["account-summary.get", "success", "", 200], ["companies.enrich", "success", "", 200]]);
      expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["zoominfo", "zoominfo"]);
    });

    it("sends a request with its headers and body, a bearer token asked for each attempt, and 30 seconds", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const fetch = answering(transient(503), doc([]));
      const getToken = vi.fn(async () => `token-${getToken.mock.calls.length}`);
      await new ZoomInfoApi(getToken).get("/data/v1/users/usage");
      await new ZoomInfoApi(getToken).post("/data/v1/contacts/search", "ContactSearch", { lastName: "Lovelace" });
      const [first, again, search] = fetch.mock.calls.map(([, init]) => init);
      expect([first, again, search].map(init => Object.fromEntries(new Headers(init.headers)))).toEqual([
        { accept: "application/vnd.api+json, application/json", authorization: "Bearer token-1" },
        { accept: "application/vnd.api+json, application/json", authorization: "Bearer token-2" },
        {
          accept: "application/vnd.api+json, application/json", authorization: "Bearer token-3",
          "content-type": "application/json",
        },
      ]);
      expect([first.body, again.body]).toEqual([undefined, undefined]);
      expect(search.body).toBe(JSON.stringify({ data: { type: "ContactSearch", attributes: { lastName: "Lovelace" } } }));
      expect(timeout.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
    });

    it("sends a GET again after a refusal for rate and an outage, and counts each attempt", async () => {
      const fetch = answering(transient(429), transient(503), doc([{ id: "usage" }]));
      await expect(zoominfo().get("/data/v1/users/usage")).resolves.toEqual({ data: [{ id: "usage" }] });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(counted()).toEqual([
        ["users.usage", "refused", "rate", 429],
        ["users.usage", "error", "http", 503],
        ["users.usage", "success", "", 200],
      ]);
    });

    it("sends a GET again after a network failure, and throws what fetch threw when it keeps failing", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const failure = new TypeError("fetch failed");
      const fetch = answering(failure);
      await expect(zoominfo().get("/data/v1/lookup/industries")).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(counted()).toEqual(Array.from({ length: 3 }, () => ["lookup.get", "error", "network", 0]));
    });

    it("throws the last answer of a GET that ZoomInfo keeps failing, sent three times", async () => {
      const fetch = answering(Response.json({ errors: [{ detail: "Service unavailable" }] },
        { status: 503, statusText: "Service Unavailable", headers: { "Retry-After": "0" } }));
      await expect(zoominfo().get("/data/v1/users/usage")).rejects.toMatchObject({
        name: "ZoomInfoApiError", status: 503, message: "503 Service Unavailable: Service unavailable",
        details: { errors: [{ detail: "Service unavailable" }] }, isAuthError: false,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it.each<[string, Response | Error, unknown[]]>([
      ["a rate limit", transient(429), ["refused", "rate", 429]],
      ["an outage", transient(503), ["error", "http", 503]],
      ["a network failure", new TypeError("fetch failed"), ["error", "network", 0]],
    ])("sends an enrichment and a search once when ZoomInfo answers %s", async (_name, failure, outcome) => {
      const fetch = answering(failure);
      const thrown = failure instanceof Error ? failure : expect.any(ZoomInfoApiError);
      await expect(zoominfo().post("/data/v1/companies/enrich", "CompanyEnrich", {})).rejects.toEqual(thrown);
      await expect(zoominfo().post("/data/v1/companies/search", "CompanySearch", {})).rejects.toEqual(thrown);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(counted()).toEqual([["companies.enrich", ...outcome], ["companies.search", ...outcome]]);
    });

    it("sends a GET whose token was rejected once, as an error that asks for a reconnect", async () => {
      const fetch = answering(Response.json({ errors: [{ detail: "Invalid token" }] }, { status: 401 }));
      await expect(zoominfo().get("/data/v1/users/usage")).rejects.toMatchObject({ status: 401, isAuthError: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([["users.usage", "error", "http", 401]]);
    });

    it("follows no redirect, and fails on one", async () => {
      const fetch = answering(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }));
      await expect(zoominfo().get("/data/v1/users/usage")).rejects.toMatchObject({ name: "ZoomInfoApiError", status: 302 });
      await expect(zoominfo().post("/data/v1/news/search", "NewsSearch", {})).rejects.toMatchObject({ status: 302 });
      expect(fetch.mock.calls.map(([, init]) => init.redirect)).toEqual(["manual", "manual"]);
      expect(counted()).toEqual([["users.usage", "error", "http", 302], ["news.search", "error", "http", 302]]);
    });

    it.each<[string, unknown, string]>([
      ["errors in place of data", { errors: [{ detail: "Not entitled" }] }, "ZoomInfo answered with no data."],
      ["neither data nor meta", {}, "ZoomInfo answered with no data."],
      ["data that is no resource", { data: "none" }, "ZoomInfo answered with no data."],
    ])("counts a document of %s, inside a success, as an error of the API, and refuses it", async (_what, body, message) => {
      const fetch = answering(Response.json(body));
      const thrown = await zoominfo().post("/data/v1/companies/enrich", "CompanyEnrich", {}).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(ZoomInfoApiError);
      expect(thrown).toMatchObject({ status: 502, message });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([["companies.enrich", "error", "api", 200]]);
    });

    it("counts data beside errors, an empty document and an empty answer as successes", async () => {
      answering(Response.json({ data: [], errors: [{ detail: "One record not matched" }] }));
      await zoominfo().post("/data/v1/contacts/enrich", "ContactEnrich", {});
      answering(Response.json({ meta: { totalResults: 0 } }));
      await zoominfo().post("/data/v1/scoops/search", "ScoopSearch", {});
      answering(new Response(null, { status: 204 }));
      await expect(zoominfo().get("/data/v1/users/usage")).resolves.toEqual({ data: null });
      expect(counted()).toEqual([
        ["contacts.enrich", "success", "", 200], ["scoops.search", "success", "", 200], ["users.usage", "success", "", 204],
      ]);
    });

    it("sends nothing under an API root that is no URL", async () => {
      const fetch = answering(doc([]));
      await expect(zoominfo("not a url").get("/data/v1/users/usage")).rejects.toBeInstanceOf(TypeError);
      expect(fetch).not.toHaveBeenCalled();
      expect(points).toEqual([]);
    });
  });

  describe("of the token endpoint", () => {
    it("counts an exchange and a refresh under their names, each sent once as a form", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const fetch = answering(Response.json(grant));
      await expect(exchange()).resolves.toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret" });
      await expect(refresh(OWN_TOKEN_URL)).resolves.toMatchObject({ scopes: ["api:data:company"] });
      expect(sent(fetch)).toEqual([["POST", TOKEN_URL], ["POST", OWN_TOKEN_URL]]);
      expect(fetch.mock.calls.map(([, init]) => [init.body, init.redirect, init.headers])).toEqual([
        [
          "grant_type=authorization_code&code=code-secret&code_verifier=verifier-secret"
            + "&redirect_uri=https%3A%2F%2Fgadgets.example%2Foauth",
          "manual",
          {
            Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa("client:client-secret")}`,
          },
        ],
        [
          "grant_type=refresh_token&refresh_token=refresh-secret&scope=api%3Adata%3Acompany",
          "manual",
          {
            Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${btoa("client:client-secret")}`,
          },
        ],
      ]);
      expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
      expect(counted()).toEqual([["token.exchange", "success", "", 200], ["token.refresh", "success", "", 200]]);
      expect(columnOf(SUBSERVICE_V1_SLOTS.operation).toSorted()).toEqual(TOKEN_OPERATIONS.toSorted());
      expect(columnOf(SUBSERVICE_V1_SLOTS.service)).toEqual(["zoominfo", "zoominfo"]);
      expect(logged.info.mock.calls.map((line: unknown[]) => line[0])).toEqual([
        expect.objectContaining({ event: "zoominfo.token.scopes", grantType: "authorization_code" }),
        expect.objectContaining({
          event: "zoominfo.token.scopes", grantType: "refresh_token", grantedScopes: ["api:data:company"],
        }),
      ]);
    });

    it("counts an OAuth error inside a success as an error of the API, thrown as a refused grant", async () => {
      const fetch = answering(Response.json({ error: "invalid_grant", error_description: "revoked" }));
      const error = await refresh().then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toMatchObject({
        name: "ZoomInfoApiError", status: 400, message: "ZoomInfo token exchange did not return an access token.",
        details: { error: "invalid_grant", error_description: "revoked" },
      });
      expect(isGrantRefused(error)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([["token.refresh", "error", "api", 200]]);
    });

    it.each([
      ["no refresh token", { ...grant, refresh_token: undefined }],
      ["an empty refresh token", { ...grant, refresh_token: "" }],
    ])("counts an exchange answered 200 with %s as an error of the API, and such a refresh as a success", async (_name, body) => {
      const fetch = answering(Response.json(body));
      const exchanged = await exchange();
      expect(exchanged).toMatchObject({ accessToken: "access-secret", expiresIn: 3600 });
      expect(isRefreshToken(exchanged.refreshToken)).toBe(false);
      expect(isRefreshToken("refresh-secret")).toBe(true);
      expect(readIdToken(exchanged.idToken, "client").userId).toBe("user-1");
      await expect(refresh()).resolves.toMatchObject({ accessToken: "access-secret" });
      expect(sent(fetch)).toEqual([["POST", TOKEN_URL], ["POST", TOKEN_URL]]);
      expect(counted()).toEqual([["token.exchange", "error", "api", 200], ["token.refresh", "success", "", 200]]);
    });

    it.each([
      ["no ID token", undefined],
      ["an ID token that cannot be decoded", "not-a-token"],
      ["an ID token naming no user", idToken({ aud: "client", email: "ada@example.com" })],
      ["an ID token for another client", idToken({ sub: "user-1", aud: "another-client" })],
    ])("counts an exchange answered 200 with %s as an error of the API, and such a refresh as a success", async (_name, token) => {
      const fetch = answering(Response.json({ ...grant, id_token: token }));
      const exchanged = await exchange();
      expect(exchanged).toMatchObject({ accessToken: "access-secret", refreshToken: "refresh-secret", idToken: token ?? null });
      expect(readIdToken(exchanged.idToken, "client").userId).toBeUndefined();
      await expect(refresh()).resolves.toMatchObject({ accessToken: "access-secret", idToken: token ?? null });
      expect(sent(fetch)).toEqual([["POST", TOKEN_URL], ["POST", TOKEN_URL]]);
      expect(counted()).toEqual([["token.exchange", "error", "api", 200], ["token.refresh", "success", "", 200]]);
    });

    it("counts a refused grant by its status, and sends it once", async () => {
      const fetch = answering(Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 }));
      const error = await refresh().then(() => undefined, (thrown: unknown) => thrown);
      expect(error).toMatchObject({ name: "ZoomInfoApiError", status: 400, message: "invalid_grant: revoked" });
      expect(isGrantRefused(error)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(counted()).toEqual([["token.refresh", "error", "http", 400]]);
      expect(logged.error.mock.calls.map((line: unknown[]) => line[0])).toEqual([expect.objectContaining({
        event: "zoominfo.token.refresh.failed", status: 400, oauthError: "invalid_grant",
      })]);
    });

    it.each<[string, Response | Error, unknown[]]>([
      ["a rate limit", transient(429), ["refused", "rate", 429]],
      ["an outage", transient(503), ["error", "http", 503]],
      ["a redirect", new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/" } }),
        ["error", "http", 307]],
      ["a network failure", new TypeError("fetch failed"), ["error", "network", 0]],
    ])("sends an exchange and a refresh once when ZoomInfo answers %s", async (_name, failure, outcome) => {
      const fetch = answering(failure);
      const thrown = failure instanceof Error ? failure : expect.any(ZoomInfoApiError);
      await expect(exchange()).rejects.toEqual(thrown);
      const error = await refresh().then(() => undefined, (refused: unknown) => refused);
      expect(error).toEqual(thrown);
      expect(isGrantRefused(error)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(counted()).toEqual([["token.exchange", ...outcome], ["token.refresh", ...outcome]]);
    });
  });

  it("writes nothing a URL, a token, a request or an answer holds", async () => {
    answering(Response.json({ errors: [{ detail: "Secret refusal about Secret_Company" }] }, { status: 403 }));
    await expect(zoominfo(OWN_API).get("/copilot/v1/companies/Secret_Company/account-summary", { q: "secret words" }))
      .rejects.toBeInstanceOf(ZoomInfoApiError);
    await expect(zoominfo().get("/data/v1/lookup/Secret_Field")).rejects.toBeInstanceOf(ZoomInfoApiError);
    answering(Response.json({ error: "invalid_client", error_description: "Secret description" }, { status: 401 }));
    await expect(refresh(OWN_TOKEN_URL)).rejects.toBeInstanceOf(ZoomInfoApiError);
    expect(counted()).toEqual([
      ["account-summary.get", "error", "http", 403], ["lookup.get", "error", "http", 403], ["token.refresh", "error", "http", 401],
    ]);
    const written = JSON.stringify(points);
    for (const secret of [
      "Secret", "secret", "proxy", "tenant-9", "api.zoominfo.com", "invalid_client", "client", "words",
    ]) expect(written).not.toContain(secret);
    for (const name of counted().map(([operation]) => operation)) {
      expect(NAMES.has(String(name)) || TOKEN_OPERATIONS.some(token => token === name)).toBe(true);
    }
  });
});
